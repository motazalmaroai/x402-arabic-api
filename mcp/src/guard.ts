// Pure, dependency-free payment checks so they can be unit-tested with mocked 402s.
export const EXPECTED = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x5cb7Cc71c117675ef36102eaed7a5Aa78A29B29a",
  decimals: 6,
} as const;

export interface Requirement {
  scheme: string;
  network: string;
  amount?: string;
  maxAmountRequired?: string;
  asset: string;
  payTo: string;
  [k: string]: unknown;
}

/** Parse MAX_PAYMENT_USDC (decimal string) into atomic units (6 decimals). Default 0.10. */
export function capAtomic(raw: string | undefined = process.env.MAX_PAYMENT_USDC): bigint {
  const s = (raw ?? "").trim() || "0.10";
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`Invalid MAX_PAYMENT_USDC: "${s}"`);
  const [i, f = ""] = s.split(".");
  return BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}

export function formatUsdc(atomic: bigint): string {
  const f = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${atomic / 1_000_000n}${f ? "." + f : ""} USDC`;
}

/** Returns null if acceptable, else a human-readable reason. */
export function checkRequirement(r: Requirement, cap: bigint): string | null {
  if (r.scheme !== EXPECTED.scheme) return `scheme mismatch: ${r.scheme}`;
  if (r.network !== EXPECTED.network) return `network mismatch: ${r.network}`;
  if (String(r.asset).toLowerCase() !== EXPECTED.asset.toLowerCase()) return `asset mismatch: ${r.asset}`;
  if (String(r.payTo).toLowerCase() !== EXPECTED.payTo.toLowerCase()) return `payTo mismatch: ${r.payTo}`;
  const raw = r.amount ?? r.maxAmountRequired;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return `invalid amount: ${String(raw)}`;
  const amt = BigInt(raw);
  if (amt > cap) return `amount ${formatUsdc(amt)} exceeds cap ${formatUsdc(cap)} (MAX_PAYMENT_USDC)`;
  return null;
}

/** Keep only requirements that pass every check (used as an x402 client policy). */
export function filterRequirements<T extends Requirement>(reqs: T[], cap: bigint): T[] {
  return reqs.filter((r) => checkRequirement(r, cap) === null);
}

/** Decode the base64 JSON PAYMENT-REQUIRED header (x402 v2). */
export function decodePaymentRequired(header: string | null): { x402Version?: number; accepts: Requirement[]; [k: string]: unknown } {
  if (!header) throw new Error("402 response without PAYMENT-REQUIRED header");
  const obj = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  if (!Array.isArray(obj?.accepts)) throw new Error("PAYMENT-REQUIRED has no accepts[]");
  return obj;
}

/** Parse MAX_TOTAL_USDC (session total cap) into atomic units. Default 0.50. */
export function totalCapAtomic(raw: string | undefined = process.env.MAX_TOTAL_USDC): bigint {
  return capAtomic((raw ?? "").trim() || "0.50");
}

/** Per-process spend tracker. Reserve before paying, commit on success, release on failure. */
export class SessionBudget {
  spent = 0n;
  reserved = 0n;
  constructor(public readonly totalCap: bigint) {}
  /** Null if `amount` fits under the total cap given spent + reserved, else a reason. */
  check(amount: bigint): string | null {
    const next = this.spent + this.reserved + amount;
    return next > this.totalCap
      ? `session total would reach ${formatUsdc(next)}, above cap ${formatUsdc(this.totalCap)} (MAX_TOTAL_USDC); already spent ${formatUsdc(this.spent)}`
      : null;
  }
  reserve(amount: bigint): string | null {
    const r = this.check(amount);
    if (r === null) this.reserved += amount;
    return r;
  }
  commit(amount: bigint): void { this.reserved -= amount; this.spent += amount; }
  release(amount: bigint): void { this.reserved -= amount; }
}

export function amountOf(r: Requirement): bigint { return BigInt((r.amount ?? r.maxAmountRequired) as string); }
