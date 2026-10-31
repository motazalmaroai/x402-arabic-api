import { createApp, buildPayment } from "./app";
import { MemoryGuard } from "./memguard";
import { SafeFacilitator, TRANSFER_TOPIC } from "./settlement";
import { resolveNetwork, PRICES } from "./config";
import type { Env } from "./config";

/**
 * Isolate warm-up, run once at MODULE SCOPE (startup time, not request CPU).
 * V8 compiles functions lazily on first call and that cost is billed to whichever request triggers it.
 * Here we push one unpaid and one paid request through an isolated copy of the full pipeline
 * (Hono router, x402 requirement building, Bazaar enrichment, zod parsing, verify/settle bookkeeping)
 * with an in-memory guard, a fake facilitator and a fake model. No network I/O, no secrets, no real payment.
 */
export function warmUp(base: Env): Promise<number[] | undefined> {
  const kv = new Map<string, string>(); // in-memory: warm-up never touches the real KV
  const env = { ...base, AI: { run: async () => ({ response: "warm" }) }, PAY_TO: base.PAY_TO,
    REDEEM: { get: async (k: string, t?: string) => { const v = kv.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, put: async (k: string, v: string) => { kv.set(k, v); } } } as any;
  const fac = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }, { x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: ["bazaar"], signers: {} }),
    verify: async (p: any) => ({ isValid: true, payer: p.payload.authorization.from }),
    settle: async (p: any, r: any) => ({ success: true, transaction: "0x" + "00".repeat(32), network: r.network, payer: p.payload.authorization.from }),
  };
  const guard = new MemoryGuard();
  const net = resolveNetwork(env);
  const pad = (a: string) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
  // Fake RPC: a receipt that matches the warm-up payment (exercises the full receipt-check code path, no I/O).
  const fakeFetch = (async () => new Response(JSON.stringify({ result: { transactionHash: "0x" + "00".repeat(32), status: "0x1", logs: [
    { address: net.usdc, topics: [TRANSFER_TOPIC, pad("0x" + "22".repeat(20)), pad(env.PAY_TO)], data: "0x" + BigInt(PRICES["/translate-ar"]).toString(16).padStart(64, "0") }] } }))) as any;
  const safe = new SafeFacilitator({ name: "warmup", client: fac as any, guard: () => guard, rpcs: ["https://rpc.invalid"], asset: net.usdc, payTo: env.PAY_TO, fetch: fakeFetch, receiptDelayMs: 0, log: () => {} });
  let pay: ReturnType<typeof buildPayment> | undefined;
  const app = createApp({ guard: () => guard, payment: (e) => (pay ??= buildPayment(e, safe)) });
  const init = (h: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "warm", ...h }, body: '{"text":"مرحبا"}' });
  return (async () => {
    const r = await app.request("https://warm.invalid/translate-ar", init(), env);
    const req = JSON.parse(atob(r.headers.get("payment-required") ?? ""));
    const a = req.accepts[0];
    const p = { x402Version: 2, accepted: a, resource: req.resource, payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x" + "22".repeat(20), to: a.payTo, value: a.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + "33".repeat(32) } } };
    const r2 = await app.request("https://warm.invalid/translate-ar", init({ "payment-signature": btoa(JSON.stringify(p)) }), env);
    await r2.text();
    return [r.status, r2.status];
    await app.request("https://warm.invalid/openapi.json", {}, env);
  })().catch(() => undefined);
}
