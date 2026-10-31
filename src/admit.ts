import type { GuardApi } from "./guard";

export type Admit = {
  ip: { key: string; limit: number }; cap: { key: string; limit: number; take?: boolean };
  payer?: { key: string; limit: number }; nonce?: { key: string; ttlSec: number };
};
export type AdmitResult = "ok" | "ip" | "cap" | "payer" | "replay";

/** Shared admission logic (DO + test double). Order: IP rate -> cap peek -> payer rate -> nonce claim -> cap take (paid only). */
export async function runAdmit(g: Pick<GuardApi, "take" | "peek" | "claimOnce">, a: Admit): Promise<AdmitResult> {
  if (!(await g.take(a.ip.key, a.ip.limit, 120))) return "ip";
  if (!(await g.peek(a.cap.key, a.cap.limit))) return "cap";
  if (a.payer && !(await g.take(a.payer.key, a.payer.limit, 120))) return "payer";
  if (a.nonce && !(await g.claimOnce(a.nonce.key, a.nonce.ttlSec))) return "replay";
  // Paid attempts reserve daily capacity here (same DO call) instead of a second round-trip in the handler.
  if (a.cap.take && !(await g.take(a.cap.key, a.cap.limit, 2 * 86400))) return "cap";
  return "ok";
}

