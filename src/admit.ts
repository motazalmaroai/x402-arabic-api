import type { GuardApi } from "./guard";

export type Budget = { key: string; n: number; limit: number };
export type Admit = {
  ip: { key: string; limit: number }; cap: { key: string; limit: number; take?: boolean };
  payer?: { key: string; limit: number }; nonce?: { key: string; ttlSec: number };
  budget?: Budget; // Workers AI neuron reservation: peeked always, taken together with cap.take
};
export type AdmitResult = "ok" | "ip" | "cap" | "payer" | "replay" | "budget";
type G = Pick<GuardApi, "take" | "peek" | "claimOnce" | "addN">;
const DAY2 = 2 * 86400;

/** Shared admission logic (DO + test double). Order: IP rate -> cap peek -> budget peek -> payer rate -> nonce claim -> cap+budget take (paid only). */
export async function runAdmit(g: G, a: Admit): Promise<AdmitResult> {
  if (!(await g.take(a.ip.key, a.ip.limit, 120))) return "ip";
  if (!(await g.peek(a.cap.key, a.cap.limit))) return "cap";
  if (a.budget && !(await g.peek(a.budget.key, a.budget.limit - a.budget.n + 1))) return "budget";
  if (a.payer && !(await g.take(a.payer.key, a.payer.limit, 120))) return "payer";
  if (a.nonce && !(await g.claimOnce(a.nonce.key, a.nonce.ttlSec))) return "replay";
  // Paid attempts reserve daily capacity here (same DO call) instead of a second round-trip in the handler.
  if (a.cap.take && !(await g.take(a.cap.key, a.cap.limit, DAY2))) return "cap";
  if (a.cap.take && a.budget && !(await g.addN(a.budget.key, a.budget.n, a.budget.limit, DAY2))) return "budget";
  return "ok";
}

export type Trial = { ip: { key: string; limit: number }; cap: { key: string; limit: number }; budget: Budget };
export type TrialResult = "ok" | "ip" | "cap" | "budget";
/** Free trial admission (one DO call): global cap + neuron budget are checked BEFORE the per-IP counter is spent. */
export async function runTrial(g: G, t: Trial): Promise<TrialResult> {
  if (!(await g.peek(t.cap.key, t.cap.limit))) return "cap";
  if (!(await g.peek(t.budget.key, t.budget.limit - t.budget.n + 1))) return "budget";
  if (!(await g.take(t.ip.key, t.ip.limit, DAY2))) return "ip";
  if (!(await g.take(t.cap.key, t.cap.limit, DAY2))) return "cap";
  if (!(await g.addN(t.budget.key, t.budget.n, t.budget.limit, DAY2))) return "budget";
  return "ok";
}
