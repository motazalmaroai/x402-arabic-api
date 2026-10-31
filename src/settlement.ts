import type { FacilitatorClient } from "@x402/core/server";
import type { GuardApi } from "./guard";
import { authorizationUsed } from "./redeem";

/**
 * SafeFacilitator — wraps exactly ONE x402 facilitator (PayAI on mainnet, x402.org on Sepolia) and enforces:
 *  1. scheme "exact" ONLY (verify/settle reject anything else; getSupported advertises only exact).
 *  2. verify -> (handler generates) -> settle -> ON-CHAIN RECEIPT CHECK -> respond.
 *     Receipt must have status=1, a USDC Transfer log from the pinned asset contract to payTo for the exact amount
 *     (from the payer), and a tx hash never seen before (claimed in the Durable Object).
 *  3. NO fallback facilitator. If verify/settle/receipt RPC is unavailable or errors, the request is marked
 *     "unavailable" and the app returns 503 with no paid content. Settle is attempted exactly once, never elsewhere.
 *  4. Successful settlements are counted per facilitator in the DO; warning logged at the PayAI threshold.
 */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const PAYAI_WARN_AT = 900;

export interface SafeOpts {
  name: string;                             // "payai" | "x402org"
  client: FacilitatorClient;
  guard: () => GuardApi;
  rpcs: string[];                           // public RPCs, tried in order (reads only)
  asset: string; payTo: string;             // pinned server-side (never from the request/facilitator)
  fetch?: typeof fetch;
  receiptAttempts?: number; receiptDelayMs?: number;
  log?: (msg: string) => void;
}

const lc = (s: unknown) => String(s ?? "").toLowerCase();
export const nonceOf = (p: any) => lc(p?.payload?.authorization?.nonce ?? p?.payload?.permit2Authorization?.nonce);
const payerOf = (p: any) => lc(p?.payload?.authorization?.from ?? p?.payload?.permit2Authorization?.from);
const schemeOf = (p: any, r: any) => p?.accepted?.scheme ?? p?.scheme ?? r?.scheme;
const pad32 = (addr: string) => "0x" + lc(addr).replace(/^0x/, "").padStart(64, "0");
export const settleKey = (name: string) => `settled:${name}`;

export class SafeFacilitator implements FacilitatorClient {
  private verified = new Set<string>();
  /** nonces whose verify/settle/receipt step hit an unavailable or erroring dependency -> app answers 503 */
  readonly unavailable = new Set<string>();
  constructor(private o: SafeOpts) {}
  get name() { return this.o.name; }
  /** On-chain USDC authorizationState(from, nonce) via the pinned asset + RPCs (redeem proof). */
  authUsed(from: string, nonce: string) { return authorizationUsed(this.o.rpcs, this.o.asset, from, nonce, this.o.fetch ?? fetch); }

  async getSupported() {
    const s: any = await this.o.client.getSupported();
    return { ...s, kinds: (s.kinds ?? []).filter((k: any) => k.scheme === "exact") };
  }

  async verify(payload: any, req: any): Promise<any> {
    if (schemeOf(payload, req) !== "exact" || req?.scheme !== "exact")
      return { isValid: false, invalidReason: "unsupported_scheme", payer: payerOf(payload) };
    const n = nonceOf(payload);
    try {
      const r: any = await this.o.client.verify(payload, req);
      if (r?.isValid) this.verified.add(n);
      return r;
    } catch {
      this.unavailable.add(n);
      return { isValid: false, invalidReason: "facilitator_unavailable", payer: payerOf(payload) };
    }
  }

  async settle(payload: any, req: any): Promise<any> {
    const network = req?.network; const payer = payerOf(payload); const n = nonceOf(payload);
    const fail = (errorReason: string, transaction = "") => ({ success: false, errorReason, transaction, network, payer });
    const down = (why: string, tx = "") => { this.unavailable.add(n); return fail(why, tx); };
    if (schemeOf(payload, req) !== "exact" || req?.scheme !== "exact") return fail("unsupported_scheme");
    if (!this.verified.delete(n)) return fail("not_verified");
    let r: any;
    try { r = await this.o.client.settle(payload, req); }       // exactly ONE settle attempt
    catch { return down("settle_unavailable"); }                 // ambiguous: 503, never re-settle anywhere
    if (!r?.success) return fail(r?.errorReason ?? "settle_failed", r?.transaction ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(r.transaction ?? "")) return down("settle_no_tx_hash");
    const why = await this.checkReceipt(r.transaction, String(req.amount), payer);
    if (why) {
      this.o.log?.(`[x402] receipt check failed (${why}) tx=${r.transaction} facilitator=${this.o.name}`);
      return why === "receipt_unavailable" ? down(why, r.transaction) : fail(why, r.transaction);
    }
    const g = this.o.guard();
    // One DO round-trip: claim tx hash (replay) + bump per-facilitator counter.
    const c = await g.recordSettlement(`tx:${lc(r.transaction)}`, 400 * 86400, settleKey(this.o.name));
    if (c < 0) return fail("tx_hash_replayed", r.transaction);
    if (this.o.name === "payai" && c >= PAYAI_WARN_AT)
      (this.o.log ?? console.warn)(`[x402] WARNING: PayAI settlements=${c} (>= ${PAYAI_WARN_AT}). Do NOT register or top up; escalate to the owner.`);
    return r;
  }

  /** Returns null if the receipt proves the payment, else a reason. */
  async checkReceipt(tx: string, amount: string, payer: string): Promise<string | null> {
    const f = this.o.fetch ?? fetch;
    const attempts = this.o.receiptAttempts ?? 8, delay = this.o.receiptDelayMs ?? 1000;
    let rc: any = null;
    for (let i = 0; i < attempts && !rc; i++) {
      for (const url of this.o.rpcs) {
        try {
          const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx] }) });
          const j: any = await res.json();
          if (j?.result) { rc = j.result; break; }
        } catch { /* try next RPC */ }
      }
      if (!rc && i < attempts - 1 && delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    if (!rc) return "receipt_unavailable";
    if (lc(rc.transactionHash) && lc(rc.transactionHash) !== lc(tx)) return "receipt_hash_mismatch";
    if (rc.status !== "0x1") return "receipt_status_not_1";
    const asset = lc(this.o.asset), to = pad32(this.o.payTo), want = BigInt(amount);
    const logs = (rc.logs ?? []).filter((l: any) => lc(l.address) === asset);
    if (!logs.length) return "receipt_no_usdc_log";
    const ok = logs.some((l: any) =>
      lc(l.topics?.[0]) === TRANSFER_TOPIC && lc(l.topics?.[2]) === to &&
      (!payer || lc(l.topics?.[1]) === pad32(payer)) && safeBig(l.data) === want);
    return ok ? null : "receipt_no_matching_transfer";
  }
}
function safeBig(h: unknown) { try { return BigInt(String(h)); } catch { return -1n; } }
