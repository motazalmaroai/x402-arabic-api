import { createApp, buildPayment } from "../src/app";
import { MemoryGuard } from "../src/memguard";
export { MemoryGuard };
import type { GuardApi } from "../src/guard";
import { SafeFacilitator, TRANSFER_TOPIC } from "../src/settlement";
import { resolveNetwork, facilitatorName } from "../src/config";

export const PAY_TO = "0x1111111111111111111111111111111111111111";
export function setup(envOver: Record<string, any> = {}) {
  const guard = new MemoryGuard();
  const calls = {
    verify: 0, settle: 0, ai: 0, settleOk: true, aiMode: "ok" as "ok" | "throw" | "empty", order: [] as string[],
    verifyMode: "ok" as "ok" | "invalid" | "throw", settleMode: "ok" as "ok" | "throw" | "nohash",
    receiptMode: "ok" as "ok" | "status0" | "wrongAsset" | "wrongTo" | "wrongAmount" | "wrongFrom" | "noLogs" | "rpcdown" | "firstRpcDown",
    fixedTx: "" as string, lastAmount: "0", authUsed: true as boolean | "down", kvDown: false, kvPuts: 0, rpc: [] as string[], logs: [] as string[], txSeq: 0,
  };
  const fakeKv: any = {
    m: new Map<string, string>(),
    async get(k: string, t?: string) { if (calls.kvDown) throw new Error("kv down"); const v = fakeKv.m.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
    async put(k: string, v: string) { if (calls.kvDown) throw new Error("kv down"); calls.kvPuts++; calls.order.push("store"); fakeKv.m.set(k, v); },
  };
  const env = {
    AI: { run: async () => { calls.ai++; calls.order.push("generate"); if (calls.aiMode === "throw") throw new Error("model down"); return { response: calls.aiMode === "empty" ? "<think>x</think>  " : "<think></think>Transparency is a core principle." }; } },
    REDEEM: fakeKv,
    X402_NETWORK: "base-sepolia", PAY_TO, FACILITATOR: "x402org-testnet", DAILY_CAP: "200", ...envOver,
  } as any;
  if (envOver.REDEEM && !envOver.REDEEM.get) env.REDEEM = fakeKv; // placeholder {} => real fake KV
  const client = {
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }, { x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "batch-settlement", network: "eip155:8453" }], extensions: ["bazaar"], signers: {} }; },
    async verify(p: any) {
      calls.verify++; calls.order.push("verify");
      if (calls.verifyMode === "throw") throw new Error("facilitator down");
      if (calls.verifyMode === "invalid") return { isValid: false, invalidReason: "invalid_signature" };
      return { isValid: true, payer: p.payload.authorization.from };
    },
    async settle(p: any, r: any) {
      calls.settle++; calls.order.push("settle"); calls.lastAmount = String(r.amount);
      if (calls.settleMode === "throw") throw new Error("timeout");
      if (!calls.settleOk) return { success: false, errorReason: "insufficient_funds", transaction: "", network: r.network };
      const tx = calls.settleMode === "nohash" ? "" : calls.fixedTx || "0x" + (++calls.txSeq).toString(16).padStart(64, "a");
      return { success: true, transaction: tx, network: r.network, payer: p.payload.authorization.from };
    },
  };
  const pad = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const fakeFetch = async (url: string, init: any) => {
    const rq = JSON.parse(init.body);
    if (rq.method === "eth_call") { calls.order.push("authState"); if (calls.authUsed === "down") throw new Error("rpc down"); return new Response(JSON.stringify({ result: "0x" + (calls.authUsed ? "1" : "0").padStart(64, "0") })); }
    calls.rpc.push(url); calls.order.push("receipt");
    const m = calls.receiptMode;
    if (m === "rpcdown" || (m === "firstRpcDown" && calls.rpc.length % 2 === 1)) throw new Error("rpc down");
    const tx = JSON.parse(init.body).params[0];
    const net = resolveNetwork(env);
    const log = {
      address: m === "wrongAsset" ? "0x" + "99".repeat(20) : net.usdc,
      topics: [TRANSFER_TOPIC, pad(m === "wrongFrom" ? "0x" + "77".repeat(20) : "0x2222222222222222222222222222222222222222"), pad(m === "wrongTo" ? "0x" + "88".repeat(20) : env.PAY_TO)],
      data: "0x" + (BigInt(calls.lastAmount) - (m === "wrongAmount" ? 1n : 0n)).toString(16).padStart(64, "0"),
    };
    return new Response(JSON.stringify({ result: { transactionHash: tx, status: m === "status0" ? "0x0" : "0x1", logs: m === "noLogs" ? [] : [log] } }));
  };
  let payment: ReturnType<typeof buildPayment> | undefined;
  const mk = (e: any) => buildPayment(e, new SafeFacilitator({
    name: facilitatorName(e.FACILITATOR), client: client as any, guard: () => guard, rpcs: [...resolveNetwork(e).rpcs],
    asset: resolveNetwork(e).usdc, payTo: e.PAY_TO, fetch: fakeFetch as any, receiptAttempts: 2, receiptDelayMs: 0, log: (m) => calls.logs.push(m),
  }));
  const app = createApp({ guard: () => guard, payment: (e) => (payment ??= mk(e)) });
  const req = (path: string, init: RequestInit = {}) => app.request(path, init, env);
  return { app, env, guard, calls, req };
}

export const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4", ...headers }, body: JSON.stringify(body),
});

export function decodeRequired(res: Response) {
  const h = res.headers.get("payment-required");
  if (!h) throw new Error("no PAYMENT-REQUIRED header");
  return JSON.parse(Buffer.from(h, "base64").toString("utf8"));
}

export function paymentHeader(accepted: any, nonce = "0x" + "01".repeat(32), from = "0x2222222222222222222222222222222222222222") {
  const payload = {
    x402Version: 2, accepted,
    payload: { signature: "0x" + "cd".repeat(65), authorization: { from, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce } },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
