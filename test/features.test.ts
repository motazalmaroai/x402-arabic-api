import { describe, it, expect } from "vitest";
import { setup, post, decodeRequired, paymentHeader, PAY_TO } from "./helpers";
import { APPROVED_MAINNET_PAY_TO, WORST_NEURONS, TRIAL_WORST_NEURONS } from "../src/config";
import { samePlaceholders, placeholders } from "../src/placeholders";
import { nums, keptVerbatim, noInvented } from "../src/verbatim";
import { matchTerms, missingTerms, GLOSSARIES, GLOSSARY_STATUS } from "../src/glossary";
import web3 from "../src/glossary/web3.json";

const MAINNET = { PAY_TO: APPROVED_MAINNET_PAY_TO, X402_NETWORK: "base", FACILITATOR: "payai", REDEEM: {} };
const MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ADDR = "0x5cb7Cc71c117675ef36102eaed7a5Aa78A29B29a";
const dataOf = (msgs: any[]) => msgs[1].content.replace(/^<data>\n/, "").replace(/\n<\/data> \/no_think$/, "");

/** Mock Workers AI. `mode(sys, data, attempt)` returns the model text. Records prompts. */
function mockAI(mode: (sys: string, data: string, n: number) => string, usage = { prompt_tokens: 100, completion_tokens: 50 }) {
  const log: { sys: string; data: string }[] = [];
  return { log, run: async (_m: string, i: any) => { const sys = i.messages[0].content, data = dataOf(i.messages); log.push({ sys, data }); return { response: mode(sys, data, log.length), usage }; } };
}
/** "Translates" by prefixing Arabic and keeping every token (a well-behaved model). */
const goodText = (_s: string, d: string) => "ترجمة: " + d;
/** Localizer that maps every value to "عربي <value>" (placeholders kept). */
const goodJson = (_s: string, d: string) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(d)).map(([k, v]) => [k, "عربي " + v])));

async function pay(t: ReturnType<typeof setup>, path: string, body: any, nonce?: string) {
  const accepted = decodeRequired(await t.req(path, post(body))).accepts[0];
  const res = await t.req(path, post(body, { "payment-signature": paymentHeader(accepted, nonce) }));
  return { accepted, res, json: await res.json().catch(() => null) };
}

const PAID: [string, string, any][] = [
  ["/translate-ar", "10000", { text: "hi" }],
  ["/summarize-ar", "20000", { text: "hi" }],
  ["/dialect-to-msa", "10000", { text: "وش الطاري" }],
  ["/localize-ar-json", "20000", { json: { a: "Hello {name}" } }],
];

describe("402 on every paid route: new amounts, same scheme/network/asset/payTo (mainnet config)", () => {
  for (const [path, amount, body] of PAID) it(`${path} -> 402 amount ${amount}`, async () => {
    const t = setup(MAINNET);
    const res = await t.req(path, post(body));
    expect(res.status).toBe(402);
    const pr = decodeRequired(res);
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:8453", asset: MAINNET_USDC, payTo: APPROVED_MAINNET_PAY_TO, amount, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } });
    const bz = pr.extensions?.bazaar;
    expect(bz?.info?.input?.body).toBeTruthy(); expect(bz?.info?.output?.example).toBeTruthy();
    expect(bz?.schema).toBeTruthy();
    expect(pr.resource.tags).toEqual(["arabic", "gulf", "saudi", "web3", "localization"]);
    expect(pr.resource.serviceName).toBe("x402 Arabic API");
    expect(pr.resource.description).toMatch(/Arabic-native, Gulf-dialect aware/);
    expect(pr.resource.description).not.toMatch(/\bfirst\b/i);
  });
  it("well-known lists 4 paid routes with new prices and the free trial", async () => {
    const t = setup(MAINNET);
    const wk = await (await t.req("https://x.test/.well-known/x402")).json();
    expect(Object.fromEntries(wk.pricing.map((p: any) => [new URL(p.resource).pathname, p.amount]))).toEqual({ "/translate-ar": "10000", "/summarize-ar": "20000", "/dialect-to-msa": "10000", "/localize-ar-json": "20000" });
    expect(wk.free[0].resource).toMatch(/\/try\/translate-ar$/); expect(wk.tags).toHaveLength(5);
  });
  it("openapi: protocols [{x402:{}}], x-guidance, security [] on free routes, no 'first'", async () => {
    const t = setup(MAINNET);
    const doc = await (await t.req("/openapi.json")).json();
    expect(doc.info["x-guidance"]).toMatch(/dialect-to-msa/);
    for (const p of ["/translate-ar", "/summarize-ar", "/dialect-to-msa", "/localize-ar-json"]) expect(doc.paths[p].post["x-payment-info"].protocols).toEqual([{ x402: {} }]);
    expect(doc.paths["/localize-ar-json"].post["x-payment-info"].price.amount).toBe("0.02");
    for (const p of ["/health", "/openapi.json", "/.well-known/x402"]) expect(doc.paths[p].get.security).toEqual([]);
    expect(doc.paths["/try/translate-ar"].post.security).toEqual([]);
    expect(JSON.stringify(doc)).not.toMatch(/\bfirst\b/i);
  });
});

describe("input validation happens before any 402", () => {
  const cases: [string, any, number][] = [
    ["/translate-ar", { text: "hi", glossary: "medical" }, 400],
    ["/dialect-to-msa", { text: "hi", direction: "x" }, 400],
    ["/dialect-to-msa", { text: "hi", dialect: "egyptian" }, 400],
    ["/localize-ar-json", { json: ["a"] }, 400],
    ["/localize-ar-json", { json: Object.fromEntries(Array.from({ length: 201 }, (_, i) => ["k" + i, "Hi"])) }, 413],
    ["/localize-ar-json", { json: { a: "x".repeat(4001), b: "y".repeat(4000) } }, 413],
    ["/localize-ar-json", { json: { a: "{name}", b: 3 } }, 400], // nothing translatable
  ];
  for (const [p, b, s] of cases) it(`${p} ${JSON.stringify(b).slice(0, 50)} -> ${s}`, async () => {
    const t = setup(); const r = await t.req(p, post(b)); expect(r.status).toBe(s); expect(r.headers.get("payment-required")).toBeNull();
  });
});

describe("paid flows for the new routes (fake facilitator, mock AI)", () => {
  it("dialect-to-msa: 200 after settle at 10000, prompt follows direction", async () => {
    const ai = mockAI(goodText); const t = setup({ AI: ai });
    const { res, json } = await pay(t, "/dialect-to-msa", { text: "ابي 3 قهوة", direction: "dialect-msa", dialect: "gulf" });
    expect(res.status).toBe(200); expect(json.direction).toBe("dialect-msa"); expect(json.dialect).toBe("gulf");
    expect(ai.log[0].sys).toMatch(/Gulf \(Khaleeji\).*into clear Modern Standard Arabic/);
    expect(t.calls.lastAmount).toBe("10000"); expect(t.calls.settle).toBe(1);
  });
  it("msa-dialect direction uses the reverse prompt", async () => {
    const ai = mockAI(goodText); const t = setup({ AI: ai });
    const { res } = await pay(t, "/dialect-to-msa", { text: "أريد قهوة", direction: "msa-dialect" });
    expect(res.status).toBe(200); expect(ai.log[0].sys).toMatch(/as natural, everyday Saudi/);
  });
  it("localize: keys unchanged, placeholders/ICU/HTML preserved, non-strings pass through, settles 20000", async () => {
    const ai = mockAI(goodJson); const t = setup({ AI: ai });
    const src = { greeting: "Hello, {name}!", nested: { items: "{count, plural, one {# item} other {# items}}", cta: 'Click <a href="https://x.io/a">here</a>', n: 5, on: true }, fee: "Fee: %s USDC (%d%%)", tpl: "{{count}} new", only: "{name}", list: ["Save", "Cancel"] };
    const { res, json } = await pay(t, "/localize-ar-json", { json: src });
    expect(res.status).toBe(200); expect(t.calls.lastAmount).toBe("20000");
    expect(json.checks.fallbackKeys).toEqual([]);
    expect(json.json.nested.n).toBe(5); expect(json.json.nested.on).toBe(true); expect(json.json.only).toBe("{name}");
    const keys = (o: any): string[] => Object.entries(o).flatMap(([k, v]) => v && typeof v === "object" ? keys(v).map((x) => k + "." + x) : [k]);
    expect(keys(json.json)).toEqual(keys(src));
    expect(json.json.nested.items).toBe("عربي {count, plural, one {# item} other {# items}}");
    expect(json.json.list).toEqual(["عربي Save", "عربي Cancel"]);
  });
  it("localize: a string broken once is retried once and fixed", async () => {
    const ai = mockAI((s, d, n) => { const o = JSON.parse(d); if (n === 1) o.k0 = "مرحبا"; else for (const k in o) o[k] = "مرحبا " + o[k]; return "```json\n" + JSON.stringify(n === 1 ? { ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === "k0" ? v : "عربي " + v])) } : o) + "\n```"; });
    const t = setup({ AI: ai });
    const { res, json } = await pay(t, "/localize-ar-json", { json: { a: "Hi {name}", b: "Bye" } });
    expect(res.status).toBe(200); expect(ai.log).toHaveLength(2);
    expect(ai.log[1].data).toContain("k0"); expect(ai.log[1].data).not.toContain("k1"); // only the failed key is retried
    expect(json.json).toEqual({ a: "مرحبا Hi {name}", b: "عربي Bye" }); expect(json.checks.fallbackKeys).toEqual([]);
  });
  const brk = () => mockAI((s, d) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(d)).map(([k, v]: any) => [k, v.includes("{{count}}") ? "عربي" : v.includes("0x") ? "عربي 0x5cb7cc71c117675ef36102eaed7a5aa78a29b29a" : "عربي " + v]))));
  it("localize: 2 of 10 broken twice (20%) => 200, source kept, JSON Pointers in checks.fallbackKeys", async () => {
    const t = setup({ AI: brk() });
    const src: any = { "a/b": { c: "{{count}} files" }, pay: `Send to ${ADDR}` };
    for (let i = 0; i < 8; i++) src["ok" + i] = "Done " + "abcdefgh"[i];
    const { res, json } = await pay(t, "/localize-ar-json", { json: src });
    expect(res.status).toBe(200); expect(t.calls.settle).toBe(1);
    expect(json.json["a/b"].c).toBe("{{count}} files"); expect(json.json.pay).toBe(src.pay); expect(json.json.ok0).toBe("عربي Done a");
    expect(json.checks.fallbackKeys.sort()).toEqual(["/a~1b/c", "/pay"]); expect(json.checks.fallbackRatio).toBe(0.2);
  });
  it("localize: >20% fallback (2 of 3) => 502 localization_failed, NOT settled, keys listed", async () => {
    const t = setup({ AI: brk() });
    const { res, json } = await pay(t, "/localize-ar-json", { json: { "a/b": { c: "{{count}} files" }, pay: `Send to ${ADDR}`, ok: "Done" } });
    expect(res.status).toBe(502); expect(json.error).toBe("localization_failed"); expect(t.calls.settle).toBe(0);
    expect(json.checks.fallbackKeys.sort()).toEqual(["/a~1b/c", "/pay"]);
  });
  it("localize: Arabic plural categories zero/two/few/many may be added (ICU parser)", async () => {
    const ar = "{count, plural, zero {لا عناصر} one {عنصر واحد} two {عنصران} few {# عناصر} many {# عنصرًا} other {# عنصر}}";
    const t = setup({ AI: mockAI(() => JSON.stringify({ k0: ar })) });
    const { res, json } = await pay(t, "/localize-ar-json", { json: { items: "{count, plural, one {# item} other {# items}}" } });
    expect(res.status).toBe(200); expect(json.json.items).toBe(ar); expect(json.checks.fallbackKeys).toEqual([]);
  });
  it("localize: invalid ICU output (unparseable / renamed arg / dropped selector / bogus category) => source, counted as fallback", async () => {
    const bad = ["{count, plural, one {# عنصر} other {# عناصر}", "{n, plural, one {# عنصر} other {# عناصر}}", "{count, plural, other {# عناصر}}", "{count, plural, one {# عنصر} several {# x} other {# عناصر}}", "{count, plural, one {# عنصر} few {{other}} other {# عناصر}}"];
    for (const b of bad) {
      const t = setup({ AI: mockAI(() => JSON.stringify({ k0: b })) });
      const { res } = await pay(t, "/localize-ar-json", { json: { items: "{count, plural, one {# item} other {# items}}" } });
      expect(res.status, b).toBe(502); expect(t.calls.settle).toBe(0);
    }
  });
  it("localize: model returns garbage for everything => 502, not charged", async () => {
    const t = setup({ AI: mockAI(() => "sorry") });
    const { res } = await pay(t, "/localize-ar-json", { json: { a: "Hi" } });
    expect(res.status).toBe(502); expect(t.calls.settle).toBe(0);
  });
});

describe("0x address / number / URL preservation (post-check, regex compare)", () => {
  const text = `Send 1,250.5 USDC to ${ADDR} before 2026-11-01, see https://basescan.org/address/${ADDR}`;
  it("well-behaved model: ok, no retry", async () => {
    const t = setup({ AI: mockAI(goodText) });
    const { res, json } = await pay(t, "/translate-ar", { text, direction: "en-ar" });
    expect(res.status).toBe(200); expect(json.checks.verbatim.ok).toBe(true); expect(json.checks.retried).toBe(false);
  });
  it("address lower-cased on attempt 1, fixed on retry => 200, retried, rejection note in the prompt", async () => {
    const ai = mockAI((s, d, n) => (n === 1 ? d.replaceAll(ADDR, ADDR.toLowerCase()) : d));
    const t = setup({ AI: ai });
    const { res, json } = await pay(t, "/translate-ar", { text });
    expect(res.status).toBe(200); expect(json.checks.retried).toBe(true); expect(json.translation).toContain(ADDR);
    expect(ai.log[1].sys).toContain("PREVIOUS ATTEMPT WAS REJECTED"); expect(ai.log[1].sys).toContain(ADDR);
  });
  it("address altered twice => 502 verbatim_check_failed, NOT settled", async () => {
    const t = setup({ AI: mockAI((s, d) => d.replaceAll(ADDR, "0x5cb7...B29a")) });
    const { res, json } = await pay(t, "/dialect-to-msa", { text: `حوّل لي على ${ADDR}` });
    expect(res.status).toBe(502); expect(json.error).toBe("verbatim_check_failed"); expect(t.calls.settle).toBe(0);
  });
  it("number changed twice => 502 verbatim_check_failed, NOT settled, retried once", async () => {
    const ai = mockAI((s, d) => d.replace("1,250.5", "about 1250"));
    const t = setup({ AI: ai });
    const { res, json } = await pay(t, "/translate-ar", { text });
    expect(res.status).toBe(502); expect(json.error).toBe("verbatim_check_failed"); expect(json.checks.verbatim.numbers).toEqual(["1250.5"]);
    expect(t.calls.settle).toBe(0); expect(ai.log).toHaveLength(2);
  });
  it("number dropped on attempt 1, fixed on retry => 200", async () => {
    const t = setup({ AI: mockAI((s, d, n) => (n === 1 ? d.replace("1,250.5 ", "") : d)) });
    const { res, json } = await pay(t, "/translate-ar", { text });
    expect(res.status).toBe(200); expect(json.checks.retried).toBe(true); expect(t.calls.settle).toBe(1);
  });
  it("number dropped twice on dialect-to-msa => 502 not settled", async () => {
    const t = setup({ AI: mockAI(() => "قهوة") });
    const { res } = await pay(t, "/dialect-to-msa", { text: "ابي 3 قهوة" });
    expect(res.status).toBe(502); expect(t.calls.settle).toBe(0);
  });
  it("Arabic-Indic digits count as the same number", () => {
    expect(nums("١٬٢٥٠٫٥ و ٣")).toEqual(["1250.5", "3"]);
    expect(keptVerbatim("Pay 1,000 USDC", "ادفع ١٬٠٠٠ USDC").ok).toBe(true);
    expect(keptVerbatim(`to ${ADDR}`, `إلى ${ADDR.toLowerCase()}`).addresses).toEqual([ADDR]);
  });
  it("summarize: invented number/address => retry; invented address twice => 502 not charged", async () => {
    const t = setup({ AI: mockAI(() => "ملخص: أرسل 99 إلى 0x" + "ab".repeat(20)) });
    const { res } = await pay(t, "/summarize-ar", { text: "Send 5 USDC." });
    expect(res.status).toBe(502); expect(t.calls.settle).toBe(0);
    expect(noInvented("a 5 b", "5").ok).toBe(true);
  });
});

describe("glossary=web3", () => {
  it("file is marked reviewed by Nouf 2026-10-31, 91 terms, ar arrays w/o diacritics, leading ال or parentheses", () => {
    expect(GLOSSARY_STATUS).toBe("reviewed by Nouf 2026-10-31");
    expect(web3.terms.length).toBe(91);
    for (const t of web3.terms) {
      expect(Array.isArray(t.ar) && t.ar.length > 0).toBe(true);
      for (const f of t.ar) { expect(f).not.toMatch(/[\u064B-\u065F\u0670]/); expect(f).not.toMatch(/[()]/); }
      expect(t.ar[0]).not.toMatch(/^ال/);
    }
  });
  it("diacritics in model output are ignored", () => {
    const [v] = matchTerms("web3", "validators", "en-ar");
    expect(missingTerms([v], "يقوم المُدقِّقون بالتحقق", "en-ar")).toEqual([]);
    const [m] = matchTerms("web3", "mint", "en-ar");
    expect(missingTerms([m], "سكّ التوكن", "en-ar")).toEqual([]);
  });
  it("ال is optional (also after و/ب/ل proclitics) and final ة inflects", () => {
    const [l] = matchTerms("web3", "liquidity", "en-ar");
    expect(missingTerms([l], "توفير السيولة", "en-ar")).toEqual([]);
    expect(missingTerms([l], "سيولة عالية", "en-ar")).toEqual([]);
    const [w] = matchTerms("web3", "wallet", "en-ar");
    expect(missingTerms([w], "بالمحفظة", "en-ar")).toEqual([]);
    expect(missingTerms([w], "افتح محفظتك", "en-ar")).toEqual([]);
    const [g] = matchTerms("web3", "gas", "en-ar");
    expect(missingTerms([g], "ادفع الغاز", "en-ar")).toEqual([]);
    expect(missingTerms([g], "ادفع الرسوم", "en-ar")).toHaveLength(1);
  });
  it("broken plurals and Latin abbreviations are accepted forms", () => {
    const t = (en: string) => matchTerms("web3", en, "en-ar")[0];
    expect(missingTerms([t("wallets")], "المحافظ", "en-ar")).toEqual([]);
    expect(missingTerms([t("smart contracts")], "العقود الذكية", "en-ar")).toEqual([]);
    expect(missingTerms([t("stablecoins")], "عملات مستقرة", "en-ar")).toEqual([]);
    expect(missingTerms([t("bridges")], "الجسور", "en-ar")).toEqual([]);
    expect(missingTerms([t("dex")], "على DEX", "en-ar")).toEqual([]);
    expect(missingTerms([t("nfts")], "مجموعة NFTs", "en-ar")).toEqual([]);
  });
  it("ar->en: لامركزية never matches مركزية (longest-first + no preceding لا)", () => {
    const en = (s: string) => matchTerms("web3", s, "ar-en").map((t) => t.en[0]).sort();
    expect(en("منصة تداول لامركزية")).toEqual(["dex"]);
    expect(en("منصة تداول مركزية")).toEqual(["cex"]);
    expect(en("التداول على منصات التداول اللامركزية والمركزية")).toEqual(["dex"]);
    const [cex] = matchTerms("web3", "cex", "en-ar");
    expect(missingTerms([cex], "منصة تداول لامركزية", "en-ar")).toHaveLength(1);
    expect(missingTerms([cex], "منصة تداول لا مركزية", "en-ar")).toHaveLength(1);
  });
  it("ar->en: diacritics and ال in the Arabic source are normalized", () => {
    expect(matchTerms("web3", "المُدقِّقون والمحافظ", "ar-en").map((t) => t.en[0]).sort()).toEqual(["validator", "wallet"]);
  });
  it("matches longest phrase first, only relevant terms", () => {
    const m = matchTerms("web3", "Pay the gas fee from your Wallet, then bridge to Base.", "en-ar").map((t) => t.ar[0]);
    expect(m.sort()).toEqual(["جسر", "رسوم الغاز", "محفظة"].sort());
    expect(matchTerms("web3", "This is a gaseous stake", "en-ar")).toEqual([]);
    expect(GLOSSARIES.web3.length).toBe(web3.terms.length);
  });
  it("terms are enforced in the prompt and post-checked (retry, then reported)", async () => {
    const ai = mockAI((s, d, n) => (n === 1 ? "ادفع الرسوم من محفظتك" : "ادفع الرسوم من المحفظة"));
    const t = setup({ AI: ai });
    const { res, json } = await pay(t, "/translate-ar", { text: "Pay the gas fee from your wallet", direction: "en-ar", glossary: "web3" });
    expect(res.status).toBe(200);
    expect(ai.log[0].sys).toContain("MANDATORY TERMINOLOGY"); expect(ai.log[0].sys).toContain("gas fee => رسوم الغاز"); expect(ai.log[0].sys).not.toContain("gas => ");
    expect(json.checks.retried).toBe(true); expect(json.checks.glossary).toBe("web3");
    expect(json.checks.glossaryMissing).toEqual(["gas fee => رسوم الغاز"]);
  });
  it("no glossary => no terminology block", async () => {
    const ai = mockAI(goodText); const t = setup({ AI: ai });
    await pay(t, "/translate-ar", { text: "my wallet" }); expect(ai.log[0].sys).not.toContain("MANDATORY");
  });
});

describe("placeholder signatures", () => {
  const same: [string, string][] = [
    ["Hello {name}", "مرحبا {name}"], ["{{count}} items", "{{count}} عناصر"], ["%s of %d", "%d من %s"], ["%1$s sent", "أرسل %1$s"],
    ["{n, plural, one {# day} other {# days}}", "{n, plural, one {# يوم} other {# أيام}}"], ["<b>Bold</b> <a href=\"/x\">link</a>", "<b>غامق</b> <a href=\"/x\">رابط</a>"],
    ["Hi :user", "مرحبا :user"], ["{0} &amp; {1}", "{0} &amp; {1}"],
  ];
  const diff: [string, string][] = [
    ["Hello {name}", "مرحبا {الاسم}"], ["{{count}} items", "{count} عناصر"], ["%s", "%d"], ["{n, plural, one {# day} other {# days}}", "{n, plural, one {يوم} other {# أيام}}"],
    ["{n, plural, one {# day} other {# days}}", "{n, plural, one {# يوم} many {# أيام}}"], ["<b>x</b>", "<strong>x</strong>"], ["<a href=\"/x\">l</a>", "<a href=\"/y\">l</a>"],
  ];
  for (const [a, b] of same) it(`same: ${a}`, () => expect(samePlaceholders(a, b)).toBe(true));
  for (const [a, b] of diff) it(`different: ${a} vs ${b}`, () => expect(samePlaceholders(a, b)).toBe(false));
  it("extracts ICU head, selectors and #", () => expect(placeholders("{n, plural, one {# x} other {# y}}")).toEqual(["#", "#", "one", "other", "{n,plural,"].sort()));
});

describe("free trial POST /try/translate-ar", () => {
  it("works without payment, 5 per IP per day, then 429", async () => {
    const t = setup({ AI: mockAI(goodText) });
    const r1 = await t.req("/try/translate-ar", post({ text: "مرحبا" }, { "cf-connecting-ip": "7.7.7.7" }));
    expect(r1.status).toBe(200); const j = await r1.json(); expect(j.trial).toBe(true); expect(r1.headers.get("payment-required")).toBeNull();
    for (let i = 0; i < 4; i++) expect((await t.req("/try/translate-ar", post({ text: "hi" }, { "cf-connecting-ip": "7.7.7.7" }))).status).toBe(200);
    const r6 = await t.req("/try/translate-ar", post({ text: "hi" }, { "cf-connecting-ip": "7.7.7.7" }));
    expect(r6.status).toBe(429); expect((await r6.json()).error).toBe("trial_limit_ip"); expect(Number(r6.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await t.req("/try/translate-ar", post({ text: "hi" }, { "cf-connecting-ip": "8.8.8.8" }))).status).toBe(200);
    expect(t.calls.settle).toBe(0); expect(t.calls.verify).toBe(0);
  });
  it("global daily cap => 429 trial_daily_cap (and the per-IP counter is not spent)", async () => {
    const t = setup({ AI: mockAI(goodText), TRIAL_DAILY_CAP: "3" });
    for (let i = 0; i < 3; i++) expect((await t.req("/try/translate-ar", post({ text: "hi" }, { "cf-connecting-ip": "1.1.1." + i }))).status).toBe(200);
    const r = await t.req("/try/translate-ar", post({ text: "hi" }, { "cf-connecting-ip": "1.1.1.9" }));
    expect(r.status).toBe(429); expect((await r.json()).error).toBe("trial_daily_cap");
  });
  it("> 200 chars => 413, model not called; max_tokens 256, no retry", async () => {
    const ai = mockAI(goodText); const t = setup({ AI: ai });
    expect((await t.req("/try/translate-ar", post({ text: "a".repeat(201) }))).status).toBe(413); expect(ai.log).toHaveLength(0);
    let mt = 0; const t2 = setup({ AI: { run: async (_: string, i: any) => { mt = i.max_tokens; return { response: "x" }; } } });
    expect((await t2.req("/try/translate-ar", post({ text: `to ${ADDR}` }))).status).toBe(200); expect(mt).toBe(256);
  });
  it("TRIAL_DAILY_CAP=0 disables it", async () => {
    const t = setup({ TRIAL_DAILY_CAP: "0" }); expect((await t.req("/try/translate-ar", post({ text: "hi" }))).status).toBe(404);
  });
});

describe("Workers AI neuron budget", () => {
  it("worst-case reservations are what the cost math says", () => {
    expect(WORST_NEURONS).toEqual({ "/translate-ar": 109, "/dialect-to-msa": 109, "/summarize-ar": 109, "/localize-ar-json": 589 });
    expect(TRIAL_WORST_NEURONS).toBe(11);
  });
  it("reservation is refunded down to actual usage", async () => {
    const t = setup({ AI: mockAI(goodText, { prompt_tokens: 1000, completion_tokens: 500 }) }); // 4.6 + 15.2 = 19.9 => 20
    await pay(t, "/translate-ar", { text: "hi" });
    const k = [...(t.guard as any).m.keys()].find((x: string) => x.startsWith("neurons:"));
    expect(await t.guard.count(k)).toBe(20);
  });
  it("budget exhausted => paid routes 503 BEFORE the 402 and trial 429", async () => {
    const t = setup({ AI: mockAI(goodText), NEURON_BUDGET: "100" });
    expect((await t.req("/translate-ar", post({ text: "hi" }))).status).toBe(503);
    expect((await t.req("/localize-ar-json", post({ json: { a: "Hi" } }))).status).toBe(503);
    const t2 = setup({ AI: mockAI(goodText), NEURON_BUDGET: "10" });
    expect((await t2.req("/try/translate-ar", post({ text: "hi" }))).status).toBe(429);
  });
});

describe("free trial never returns 402 and never unlocks a paid route", () => {
  const TRY = "/try/translate-ar";
  const sig = (t: ReturnType<typeof setup>) => ({ "payment-signature": paymentHeader({ scheme: "exact", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: PAY_TO, amount: "10000", maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } }), "x-payment": "abc" });
  const no402 = async (r: Response) => { expect(r.status).not.toBe(402); expect(r.headers.get("payment-required")).toBeNull(); expect(r.headers.get("payment-response")).toBeNull(); return r; };
  it("every branch: ok, 413, bad JSON, missing text, GET, model error, empty output, ip limit, daily cap, budget, disabled, with payment headers", async () => {
    const t = setup({ AI: mockAI(goodText) });
    expect((await no402(await t.req(TRY, post({ text: "hi" }, sig(t))))).status).toBe(200);
    expect((await no402(await t.req(TRY, post({ text: "a".repeat(201) })))).status).toBe(413);
    expect((await no402(await t.req(TRY, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" }))).status).toBe(400);
    expect((await no402(await t.req(TRY, post({})))).status).toBe(400);
    await no402(await t.req(TRY));
    const te = setup({ AI: { run: async () => { throw new Error("down"); } } });
    expect((await no402(await te.req(TRY, post({ text: "hi" })))).status).toBe(502);
    const t0 = setup({ AI: { run: async () => ({ response: "  " }) } });
    expect((await no402(await t0.req(TRY, post({ text: "hi" })))).status).toBe(502);
    for (let i = 0; i < 5; i++) await no402(await t.req(TRY, post({ text: "hi" }, { "cf-connecting-ip": "9.9.9.9", ...sig(t) })));
    expect((await no402(await t.req(TRY, post({ text: "hi" }, { "cf-connecting-ip": "9.9.9.9" })))).status).toBe(429);
    const tc = setup({ AI: mockAI(goodText), TRIAL_DAILY_CAP: "1" });
    await no402(await tc.req(TRY, post({ text: "hi" }, { "cf-connecting-ip": "1.0.0.1" })));
    expect((await no402(await tc.req(TRY, post({ text: "hi" }, { "cf-connecting-ip": "1.0.0.2" })))).status).toBe(429);
    const tb = setup({ AI: mockAI(goodText), NEURON_BUDGET: "5" });
    expect((await no402(await tb.req(TRY, post({ text: "hi" })))).status).toBe(429);
    const td = setup({ TRIAL_DAILY_CAP: "0" });
    expect((await no402(await td.req(TRY, post({ text: "hi" }, sig(td))))).status).toBe(404);
    const ts = setup({ AI: mockAI(goodText), SETTLE_STOP: "1" }); await ts.guard.incr("settled:x402org");
    expect((await no402(await ts.req(TRY, post({ text: "hi" })))).status).toBe(200);
    for (const x of [t, te, t0, tc, tb, td, ts]) { expect(x.calls.verify).toBe(0); expect(x.calls.settle).toBe(0); }
  });
  it("default TRIAL_DAILY_CAP is 100", async () => {
    const { DEFAULT_TRIAL_DAILY_CAP, TRIAL_PER_IP_PER_DAY } = await import("../src/config");
    expect(DEFAULT_TRIAL_DAILY_CAP).toBe(100); expect(TRIAL_PER_IP_PER_DAY).toBe(5);
  });
  it("trial calls do not unlock paid routes; path tricks still hit the paid gate", async () => {
    const t = setup({ AI: mockAI(goodText) });
    for (let i = 0; i < 3; i++) await t.req(TRY, post({ text: "hi" }));
    for (const [p, , b] of PAID) { const r = await t.req(p, post(b)); expect(r.status).toBe(402); }
    for (const p of ["/try/../translate-ar", "/try/%2e%2e/translate-ar", "/TRY/translate-ar/../../translate-ar"]) {
      const r = await t.req(p, post({ text: "hi" }));
      expect([402, 404]).toContain(r.status); if (r.status !== 402) expect(r.headers.get("payment-required")).toBeNull();
    }
    expect((await t.req("/try/../translate-ar", post({ text: "hi" }))).status).toBe(402);
    expect((await t.req("/try/summarize-ar", post({ text: "hi" }))).status).toBe(404);
    expect(t.calls.settle).toBe(0); expect(t.calls.verify).toBe(0);
  });
});

describe("settlement stop (SETTLE_STOP, default 900)", () => {
  it("below the stop: 402 as usual; /health shows the threshold, not stopped", async () => {
    const t = setup(MAINNET);
    for (let i = 0; i < 899; i++) await t.guard.incr("settled:payai");
    expect((await t.req("/translate-ar", post({ text: "hi" }))).status).toBe(402);
    const h = await (await t.req("/health")).json();
    expect(h.settlements.payai).toBe(899); expect(h.settleStop).toEqual({ at: 900, stopped: false });
  });
  it("at the stop: every paid route 503 settlement_stop BEFORE any 402 (with or without a payment header); /health stopped", async () => {
    const t = setup(MAINNET);
    for (let i = 0; i < 900; i++) await t.guard.incr("settled:payai");
    for (const [p, , b] of PAID) {
      const r = await t.req(p, post(b)); expect(r.status).toBe(503); expect(r.headers.get("payment-required")).toBeNull();
      expect((await r.json()).error).toBe("settlement_stop");
      const g = await t.req(p); expect(g.status).toBe(503);
    }
    const r = await t.req("/translate-ar", post({ text: "hi" }, { "payment-signature": "eyJ4Ijox fQ==" }));
    expect(r.status).toBe(503);
    expect(t.calls.verify).toBe(0); expect(t.calls.settle).toBe(0);
    expect((await (await t.req("/health")).json()).settleStop).toEqual({ at: 900, stopped: true });
  });
  it("the counter reaching the stop through real settlements pauses the next request", async () => {
    const t = setup({ AI: mockAI(goodText), SETTLE_STOP: "1" });
    expect((await pay(t, "/translate-ar", { text: "hi" })).res.status).toBe(200);
    expect((await t.req("/translate-ar", post({ text: "hi" }))).status).toBe(503);
  });
  it("SETTLE_STOP raised => resumes; \"0\" => disabled", async () => {
    const t = setup({ ...MAINNET, SETTLE_STOP: "1500" });
    for (let i = 0; i < 900; i++) await t.guard.incr("settled:payai");
    expect((await t.req("/translate-ar", post({ text: "hi" }))).status).toBe(402);
    const t0 = setup({ ...MAINNET, SETTLE_STOP: "0" });
    for (let i = 0; i < 5000; i++) await t0.guard.incr("settled:payai");
    expect((await t0.req("/translate-ar", post({ text: "hi" }))).status).toBe(402);
    expect((await (await t0.req("/health")).json()).settleStop).toEqual({ at: null, stopped: false });
  });
  it("guard unavailable => fails closed (503)", async () => {
    const t = setup(MAINNET); (t.guard as any).count = async () => { throw new Error("down"); };
    expect((await t.req("/translate-ar", post({ text: "hi" }))).status).toBe(503);
  });
});

describe("favicon", () => {
  it("GET /favicon.ico: 200 svg, free, no 402, no guard use", async () => {
    const t = setup(MAINNET);
    const r = await t.req("/favicon.ico");
    expect(r.status).toBe(200); expect(r.headers.get("content-type")).toMatch(/svg/); expect(r.headers.get("payment-required")).toBeNull();
    expect((await r.text()).length).toBeLessThan(1024); expect(t.guard.m.size).toBe(0);
  });
});
