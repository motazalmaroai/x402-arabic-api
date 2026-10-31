import { validatePayment } from "../src/redeem";
import { describe, it, expect } from "vitest";
import { setup, post, decodeRequired, paymentHeader, PAY_TO } from "./helpers";
import { validateOpenApi } from "./openapi-validate";
import { defaultFacilitator } from "../src/app";
import { SafeFacilitator, settleKey } from "../src/settlement";
import { NETWORKS, paymentConfigError, APPROVED_MAINNET_PAY_TO } from "../src/config";
const MAINNET = { PAY_TO: APPROVED_MAINNET_PAY_TO, X402_NETWORK: "base", FACILITATOR: "payai", REDEEM: {} };

const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

describe("402 payment requirements", () => {
  it("unpaid translate -> 402 with exact amount/network/asset/payTo (Base Sepolia default)", async () => {
    const { req, calls } = setup();
    const res = await req("/translate-ar", post({ text: "مرحبا" }));
    expect(res.status).toBe(402);
    const pr = decodeRequired(res);
    expect(pr.x402Version).toBe(2);
    const a = pr.accepts[0];
    expect(a).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "50000", asset: SEPOLIA_USDC, payTo: PAY_TO });
    expect(pr.extensions?.bazaar).toBeTruthy();
    expect(calls.ai).toBe(0);
  });
  it("summarize price is 70000 (0.07 USDC); mainnet only via config switch", async () => {
    const { req } = setup(MAINNET);
    const a = decodeRequired(await req("/summarize-ar", post({ text: "hello" }))).accepts[0];
    expect(a).toMatchObject({ network: "eip155:8453", amount: "70000", asset: MAINNET_USDC });
  });
  it("ignores client-supplied payTo/price/network/asset", async () => {
    const { req } = setup();
    const evil = "0x9999999999999999999999999999999999999999";
    const res = await req("/translate-ar?payTo=" + evil + "&price=1&network=eip155:1",
      post({ text: "hi", payTo: evil, price: "1", amount: "1", network: "eip155:1", asset: evil }, { "x-pay-to": evil, "x-price": "1" }));
    const a = decodeRequired(res).accepts[0];
    expect(a.payTo).toBe(PAY_TO); expect(a.amount).toBe("50000"); expect(a.network).toBe("eip155:84532"); expect(a.asset).toBe(SEPOLIA_USDC);
  });
  it("fails closed (503) when PAY_TO unset", async () => {
    const { req } = setup({ PAY_TO: "" });
    expect((await req("/translate-ar", post({ text: "hi" }))).status).toBe(503);
  });
});

describe("paid flow", () => {
  it("returns 200 only after verify AND settle; identical resend redeems stored body (no 2nd settle)", async () => {
    const { req, calls } = setup();
    const accepted = decodeRequired(await req("/translate-ar", post({ text: "مرحبا" }))).accepts[0];
    const ph = paymentHeader(accepted);
    const ok = await req("/translate-ar", post({ text: "مرحبا" }, { "payment-signature": ph }));
    expect(ok.status).toBe(200);
    expect(calls.verify).toBe(1); expect(calls.settle).toBe(1);
    expect(ok.headers.get("payment-response")).toBeTruthy();
    expect((await ok.json()).translation).toBe("Transparency is a core principle.");
    const replay = await req("/translate-ar", post({ text: "مرحبا" }, { "payment-signature": ph }));
    expect(replay.status).toBe(200); expect(replay.headers.get("x-x402-redeemed")).toBe("true");
    expect((await replay.json()).translation).toBe("Transparency is a core principle.");
    expect(calls.ai).toBe(1); expect(calls.settle).toBe(1); expect(calls.verify).toBe(1);
  });
  it("settle failure => no paid body released", async () => {
    const { req, calls } = setup();
    calls.settleOk = false;
    const accepted = decodeRequired(await req("/translate-ar", post({ text: "hi" }))).accepts[0];
    const res = await req("/translate-ar", post({ text: "hi" }, { "payment-signature": paymentHeader(accepted) }));
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain("Transparency");
  });
  it("payment signed for a different payTo is rejected", async () => {
    const { req, calls } = setup();
    const accepted = decodeRequired(await req("/translate-ar", post({ text: "hi" }))).accepts[0];
    const forged = { ...accepted, payTo: "0x9999999999999999999999999999999999999999", amount: "1" };
    const res = await req("/translate-ar", post({ text: "hi" }, { "payment-signature": paymentHeader(forged) }));
    expect(res.status).toBe(400); expect((await res.json()).detail).toBe("bad_pay_to"); // manual validation, before verify
    expect(calls.verify).toBe(0); expect(calls.ai).toBe(0); expect(calls.settle).toBe(0);
  });
});

describe("caps & limits", () => {
  it("daily cap hit -> 503 before the model, and before any 402", async () => {
    const { req, calls } = setup({ DAILY_CAP: "1" });
    const accepted = decodeRequired(await req("/translate-ar", post({ text: "hi" }))).accepts[0];
    expect((await req("/translate-ar", post({ text: "hi" }, { "payment-signature": paymentHeader(accepted) }))).status).toBe(200);
    const res = await req("/translate-ar", post({ text: "hi" }));
    expect(res.status).toBe(503);
    expect(calls.ai).toBe(1);
  });
  it("oversized input rejected (413) by chars and by bytes", async () => {
    const { req, calls } = setup();
    expect((await req("/translate-ar", post({ text: "ا".repeat(4001) }))).status).toBe(413);
    expect((await req("/summarize-ar", post({ text: "a", pad: "x".repeat(20000) }))).status).toBe(413);
    expect(calls.ai).toBe(0);
  });
  it("per-IP rate limit -> 429", async () => {
    const { req } = setup();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await req("/translate-ar", post({ text: "hi" }, { "cf-connecting-ip": "9.9.9.9" }))).status;
    expect(last).toBe(429);
  });
  it("per-payer rate limit -> 429", async () => {
    const { req } = setup();
    const accepted = decodeRequired(await req("/translate-ar", post({ text: "hi" }))).accepts[0];
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const nonce = "0x" + (i + 1).toString(16).padStart(64, "0");
      last = (await req("/translate-ar", post({ text: "hi" }, { "payment-signature": paymentHeader(accepted, nonce), "cf-connecting-ip": "10.0.0." + i }))).status;
    }
    expect(last).toBe(429);
  });
});

describe("free endpoints", () => {
  it("openapi.json is valid OpenAPI 3.1 with Use when: lines", async () => {
    const { req } = setup();
    const doc = await (await req("/openapi.json")).json();
    await validateOpenApi(doc);
    for (const p of ["/translate-ar", "/summarize-ar"]) expect(doc.paths[p].post.description).toMatch(/^Use when:/);
  });
  it("health, docs, well-known", async () => {
    const { req } = setup();
    expect((await req("/health")).status).toBe(200);
    expect((await req("/")).status).toBe(200);
    const wk = await (await req("/.well-known/x402")).json();
    expect(wk.resources).toHaveLength(2);
    const g = await req("/translate-ar");
    expect(g.status).toBe(402);
    expect(decodeRequired(g).accepts[0].amount).toBe("50000");
  });
});

describe("payment ordering: verify -> generate -> settle -> return", () => {
  async function paid(mode: "ok" | "throw" | "empty") {
    const t = setup(); t.calls.aiMode = mode;
    const accepted = decodeRequired(await t.req("/translate-ar", post({ text: "مرحبا" }))).accepts[0];
    const res = await t.req("/translate-ar", post({ text: "مرحبا" }, { "payment-signature": paymentHeader(accepted) }));
    return { res, calls: t.calls };
  }
  it("success: strict order verify, generate, settle", async () => {
    const { res, calls } = await paid("ok");
    expect(res.status).toBe(200);
    expect(calls.order).toEqual(["verify", "generate", "store", "settle", "receipt"]); // body stored for redeem BEFORE settle
  });
  it("generation throws => 5xx, settle never called, no charge", async () => {
    const { res, calls } = await paid("throw");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "model_error" });
    expect(calls.verify).toBe(1); expect(calls.settle).toBe(0);
    expect(res.headers.get("payment-response")).toBeNull();
  });
  it("generation empty => 5xx, settle never called", async () => {
    const { res, calls } = await paid("empty");
    expect(res.status).toBe(502);
    expect(calls.order).toEqual(["verify", "generate"]);
  });
});

describe("mainnet startup guard", () => {
  it("valid mainnet config serves 402 on Base USDC", async () => {
    expect(paymentConfigError({ ...MAINNET } as any)).toBeNull();
  });
  it("mainnet accepts ONLY the PayAI facilitator (no other facilitator)", async () => {
    for (const f of ["x402org-testnet", "daydreams", "cdp", undefined]) {
      const r = await setup({ ...MAINNET, FACILITATOR: f }).req("/translate-ar", post({ text: "hi" }));
      expect(r.status).toBe(503); expect((await r.json()).detail).toBe("mainnet_requires_payai");
    }
    expect(() => defaultFacilitator({ ...MAINNET, FACILITATOR: "daydreams" } as any, () => null as any)).toThrow();
    expect(defaultFacilitator({ ...MAINNET } as any, () => null as any).name).toBe("payai");
    expect(defaultFacilitator({ X402_NETWORK: "base-sepolia", FACILITATOR: "x402org-testnet", PAY_TO } as any, () => null as any).name).toBe("x402org");
  });
  it("refuses a non-approved PAY_TO on mainnet", async () => {
    const r = await setup({ ...MAINNET, PAY_TO: "0x" + "ab".repeat(20) }).req("/translate-ar", post({ text: "hi" }));
    expect(r.status).toBe(503); expect((await r.json()).detail).toBe("pay_to_not_approved");
  });
  it("refuses on asset/network mismatch", async () => {
    const orig = NETWORKS.base.usdc;
    (NETWORKS.base as any).usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    try {
      const r = await setup(MAINNET).req("/translate-ar", post({ text: "hi" }));
      expect(r.status).toBe(503); expect((await r.json()).detail).toBe("asset_network_mismatch");
    } finally { (NETWORKS.base as any).usdc = orig; }
  });
});

async function payOnce(t: ReturnType<typeof setup>, nonce = "0x" + "01".repeat(32)) {
  const accepted = decodeRequired(await t.req("/translate-ar", post({ text: "مرحبا" }))).accepts[0];
  const res = await t.req("/translate-ar", post({ text: "مرحبا" }, { "payment-signature": paymentHeader(accepted, nonce) }));
  const body = await res.text();
  return { res, body, accepted };
}
const noPaidContent = (body: string) => expect(body).not.toContain("Transparency");

describe("scheme: exact only", () => {
  it("advertises only exact", async () => {
    const t = setup();
    const req = decodeRequired(await t.req("/translate-ar", post({ text: "hi" })));
    expect(req.accepts.length).toBeGreaterThan(0);
    expect(req.accepts.every((a: any) => a.scheme === "exact")).toBe(true);
  });
  it("rejects a non-exact payment header before verify (400)", async () => {
    const t = setup();
    for (const scheme of ["upto", "batch-settlement"]) {
      const accepted = { ...decodeRequired(await t.req("/translate-ar", post({ text: "hi" }))).accepts[0], scheme };
      const r = await t.req("/translate-ar", post({ text: "hi" }, { "payment-signature": paymentHeader(accepted, "0x" + scheme.length.toString(16).padStart(64, "0")) }));
      expect(r.status).toBe(400); expect((await r.json()).error).toBe("unsupported_scheme");
    }
    expect(t.calls.verify).toBe(0); expect(t.calls.settle).toBe(0);
  });
  it("SafeFacilitator refuses non-exact verify/settle without contacting the facilitator, and filters /supported", async () => {
    let hits = 0;
    const client = { getSupported: async () => ({ kinds: [{ scheme: "exact" }, { scheme: "upto" }, { scheme: "batch-settlement" }] }), verify: async () => { hits++; return { isValid: true }; }, settle: async () => { hits++; return { success: true }; } };
    const f = new SafeFacilitator({ name: "payai", client: client as any, guard: () => null as any, rpcs: [], asset: "0x", payTo: "0x" });
    const p = { accepted: { scheme: "upto" }, payload: { authorization: { nonce: "0x1", from: "0x2" } } };
    expect((await f.verify(p, { scheme: "upto" })).isValid).toBe(false);
    expect((await f.settle(p, { scheme: "upto" })).success).toBe(false);
    expect(hits).toBe(0);
    expect((await f.getSupported()).kinds).toEqual([{ scheme: "exact" }]);
  });
});

describe("single facilitator, no fallback; unavailable => 503 with no paid content", () => {
  it("verify error => 503, no generation, no settle", async () => {
    const t = setup(); t.calls.verifyMode = "throw";
    const { res, body } = await payOnce(t);
    expect(res.status).toBe(503); expect(JSON.parse(body)).toEqual({ error: "facilitator_unavailable" });
    expect(t.calls.verify).toBe(1); expect(t.calls.ai).toBe(0); expect(t.calls.settle).toBe(0);
  });
  it("verify invalid => 402, exactly one verify (no other facilitator tried)", async () => {
    const t = setup(); t.calls.verifyMode = "invalid";
    const { res, body } = await payOnce(t);
    expect(res.status).toBe(402); noPaidContent(body);
    expect(t.calls.verify).toBe(1); expect(t.calls.settle).toBe(0);
  });
  it("settle error => 503, settle attempted exactly once, never re-settled, no paid content", async () => {
    const t = setup(); t.calls.settleMode = "throw";
    const { res, body } = await payOnce(t);
    expect(res.status).toBe(503); noPaidContent(body);
    expect(t.calls.settle).toBe(1); expect(t.calls.rpc.length).toBe(0);
    expect(res.headers.get("payment-response")).toBeNull();
  });
  it("settle success without a tx hash => 503 (ambiguous), no paid content", async () => {
    const t = setup(); t.calls.settleMode = "nohash";
    const { res, body } = await payOnce(t);
    expect(res.status).toBe(503); noPaidContent(body); expect(t.calls.settle).toBe(1);
  });
  it("settle declined => 402, no paid content", async () => {
    const t = setup(); t.calls.settleOk = false;
    const { res, body } = await payOnce(t);
    expect(res.status).toBe(402); noPaidContent(body); expect(t.calls.settle).toBe(1);
  });
});

describe("on-chain receipt check (after settle, before respond)", () => {
  it("passes: status=1, USDC log, Transfer payer->payTo exact amount; counted per facilitator", async () => {
    const t = setup();
    const { res, body } = await payOnce(t);
    expect(res.status).toBe(200); expect(body).toContain("Transparency");
    expect(t.calls.rpc[0]).toBe("https://sepolia.base.org");
    expect(await t.guard.count(settleKey("x402org"))).toBe(1);
    const h = await (await t.req("/health")).json();
    expect(h.settlements).toEqual({ x402org: 1 }); expect(h.facilitator).toBe("x402org"); expect(h.scheme).toBe("exact");
  });
  for (const mode of ["status0", "wrongAsset", "wrongTo", "wrongAmount", "wrongFrom", "noLogs"] as const) {
    it(`fails on ${mode} => 402, no paid content, not counted`, async () => {
      const t = setup(); t.calls.receiptMode = mode;
      const { res, body } = await payOnce(t);
      expect(res.status).toBe(402); noPaidContent(body);
      expect(await t.guard.count(settleKey("x402org"))).toBe(0);
    });
  }
  it("all RPCs unreachable => 503, no paid content", async () => {
    const t = setup(); t.calls.receiptMode = "rpcdown";
    const { res, body } = await payOnce(t);
    expect(res.status).toBe(503); noPaidContent(body);
    expect(t.calls.rpc).toEqual(["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]);
    expect(t.calls.settle).toBe(1);
  });
  it("primary RPC down => fallback RPC used, 200", async () => {
    const t = setup(); t.calls.receiptMode = "firstRpcDown";
    const { res } = await payOnce(t);
    expect(res.status).toBe(200);
    expect(t.calls.rpc).toEqual(["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]);
  });
  it("tx hash seen before => 402, no paid content (stored in DO)", async () => {
    const t = setup(); t.calls.fixedTx = "0x" + "ef".repeat(32);
    expect((await payOnce(t, "0x" + "01".repeat(32))).res.status).toBe(200);
    const second = await payOnce(t, "0x" + "02".repeat(32));
    expect(second.res.status).toBe(402); noPaidContent(second.body);
    expect(await t.guard.count(settleKey("x402org"))).toBe(1);
  });
  it("mainnet uses Base mainnet RPC + Base USDC and counts PayAI; warns at 900", async () => {
    const t = setup(MAINNET);
    (t.guard as any).m.set(settleKey("payai"), { n: 899, exp: Number.MAX_SAFE_INTEGER });
    const { res, accepted } = await payOnce(t);
    expect(accepted.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"); expect(accepted.network).toBe("eip155:8453");
    expect(res.status).toBe(200);
    expect(t.calls.rpc[0]).toBe("https://mainnet.base.org");
    expect(await t.guard.count(settleKey("payai"))).toBe(900);
    expect(t.calls.logs.some((l) => l.includes("PayAI settlements=900"))).toBe(true);
    expect((await (await t.req("/health")).json()).settlements).toEqual({ payai: 900 });
  });
  it("PayAI below 900 => no warning", async () => {
    const t = setup(MAINNET);
    await payOnce(t);
    expect(t.calls.logs.length).toBe(0);
  });
});

describe("lost-response redeem", () => {
  const first = async (s: ReturnType<typeof setup>, nonce?: string) => {
    const accepted = decodeRequired(await s.req("/translate-ar", post({ text: "مرحبا" }))).accepts[0];
    const ph = paymentHeader(accepted, nonce);
    const r = await s.req("/translate-ar", post({ text: "مرحبا" }, { "payment-signature": ph }));
    return { accepted, ph, r, body: await r.text() };
  };
  it("stored value has payload hash + body, never the input text; TTL 3600", async () => {
    const s = setup(); const puts: any[] = [];
    const orig = s.env.REDEEM.put; s.env.REDEEM.put = async (k: string, v: string, o: any) => { puts.push({ k, v, o }); return orig(k, v); };
    const { r } = await first(s);
    expect(r.status).toBe(200);
    expect(puts).toHaveLength(1); expect(puts[0].o).toEqual({ expirationTtl: 3600 });
    expect(puts[0].k).toMatch(/^redeem:[0-9a-f]{64}$/);
    const v = JSON.parse(puts[0].v); expect(v.h).toMatch(/^[0-9a-f]{64}$/); expect(v.body).toContain("Transparency");
    expect(puts[0].v).not.toContain("مرحبا");
  });
  it("different payload with same from+nonce => 409", async () => {
    const s = setup(); const { accepted, ph } = await first(s);
    const p = JSON.parse(Buffer.from(ph, "base64").toString()); p.payload.signature = "0x" + "ef".repeat(65);
    const r = await s.req("/translate-ar", post({ text: "مرحبا" }, { "payment-signature": Buffer.from(JSON.stringify(p)).toString("base64") }));
    expect(r.status).toBe(409); expect(s.calls.settle).toBe(1); void accepted;
  });
  it("identical resend to a different endpoint => 409 (400 by price check)", async () => {
    const s = setup(); const { ph } = await first(s);
    const r = await s.req("/summarize-ar", post({ text: "مرحبا" }, { "payment-signature": ph }));
    expect([400, 409]).toContain(r.status); expect(s.calls.settle).toBe(1);
  });
  it("not settled on-chain (authorizationState false) => 409", async () => {
    const s = setup(); s.calls.settleOk = false;
    const { ph, r } = await first(s); expect(r.status).toBe(402);
    s.calls.authUsed = false;
    const again = await s.req("/translate-ar", post({ text: "مرحبا" }, { "payment-signature": ph }));
    expect(again.status).toBe(409);
  });
  it("lost response after on-chain settle (receipt step failed) => resend returns stored body", async () => {
    const s = setup(); s.calls.receiptMode = "rpcdown";
    const { ph, r } = await first(s); expect(r.status).toBe(503); // response lost / withheld after settle
    s.calls.receiptMode = "ok"; s.calls.authUsed = true;
    const again = await s.req("/translate-ar", post({ text: "مرحبا" }, { "payment-signature": ph }));
    expect(again.status).toBe(200); expect(await again.text()).toContain("Transparency"); expect(s.calls.settle).toBe(1);
  });
  it("RPC down during redeem => 503, no body", async () => {
    const s = setup(); const { ph } = await first(s); s.calls.authUsed = "down";
    const r = await s.req("/translate-ar", post({ text: "مرحبا" }, { "payment-signature": ph }));
    expect(r.status).toBe(503); expect(await r.text()).not.toContain("Transparency");
  });
  it("no stored response => 409", async () => {
    const s = setup(); const { ph } = await first(s); (s.env.REDEEM as any).m.clear();
    const r = await s.req("/translate-ar", post({ text: "مرحبا" }, { "payment-signature": ph }));
    expect(r.status).toBe(409);
  });
  it("KV store failure before settle => 503 and NO settle", async () => {
    const s = setup();
    const accepted = decodeRequired(await s.req("/translate-ar", post({ text: "hi" }))).accepts[0];
    s.calls.kvDown = true;
    const r = await s.req("/translate-ar", post({ text: "hi" }, { "payment-signature": paymentHeader(accepted) }));
    expect(r.status).toBe(503); expect(s.calls.settle).toBe(0);
  });
  it("missing REDEEM binding disables paid routes", async () => {
    const s = setup({ REDEEM: undefined });
    const r = await s.req("/translate-ar", post({ text: "hi" }));
    expect(r.status).toBe(503); expect((await r.json()).detail).toBe("redeem_store_not_configured");
  });
});

describe("manual payment validation (no JSON-schema lib on the payment path)", () => {
  const E = { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: PAY_TO, amount: "50000", nowSec: 1_000_000 };
  const good = () => ({ x402Version: 2, accepted: { scheme: "exact", network: E.network, asset: E.asset, payTo: PAY_TO, amount: "50000" },
    payload: { signature: "0x" + "ab".repeat(65), authorization: { from: "0x" + "22".repeat(20), to: PAY_TO, value: "50000", validAfter: "0", validBefore: "1000600", nonce: "0x" + "01".repeat(32) } } });
  const cases: [string, (p: any) => void][] = [
    ["bad_x402_version", (p) => (p.x402Version = 1)],
    ["bad_scheme", (p) => (p.accepted.scheme = "upto")],
    ["bad_network", (p) => (p.accepted.network = "eip155:8453")],
    ["bad_asset", (p) => (p.accepted.asset = "0x" + "99".repeat(20))],
    ["bad_pay_to", (p) => (p.accepted.payTo = "0x" + "98".repeat(20))],
    ["bad_amount", (p) => (p.accepted.amount = "1")],
    ["missing_authorization", (p) => delete p.payload.authorization],
    ["bad_from", (p) => (p.payload.authorization.from = "0x12")],
    ["bad_authorization_to", (p) => (p.payload.authorization.to = "0x" + "98".repeat(20))],
    ["bad_authorization_value", (p) => (p.payload.authorization.value = "49999")],
    ["bad_validity_format", (p) => (p.payload.authorization.validAfter = "-1")],
    ["not_yet_valid", (p) => (p.payload.authorization.validAfter = "1000100")],
    ["expired_or_expiring", (p) => (p.payload.authorization.validBefore = "1000003")],
    ["bad_nonce_format", (p) => (p.payload.authorization.nonce = "0x01")],
    ["bad_signature_format", (p) => (p.payload.signature = "0x" + "ab".repeat(64))],
    ["bad_signature_format", (p) => (p.payload.signature = "0xzz" + "ab".repeat(65))],
  ];
  it("accepts a well-formed payment", () => expect(validatePayment(good(), E)).toBeNull());
  for (const [want, mut] of cases) it(`rejects: ${want}`, () => { const p = good(); mut(p); expect(validatePayment(p, E)).toBe(want); });
});
