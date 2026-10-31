import { DurableObject } from "cloudflare:workers";
import { runAdmit, runTrial, type Admit, type AdmitResult, type Trial, type TrialResult } from "./admit";
export type { Admit, AdmitResult, Trial, TrialResult };

/** Strongly consistent counters: daily cap, replay nonces, rate limits. Single global instance. */
export interface GuardApi {
  take(key: string, limit: number, ttlSec: number): Promise<boolean>; // counter < limit -> increment, true
  peek(key: string, limit: number): Promise<boolean>;                // true if below limit
  claimOnce(key: string, ttlSec: number): Promise<boolean>;          // false if already claimed (replay)
  admit(a: Admit): Promise<AdmitResult>;
  trial(t: Trial): Promise<TrialResult>;
  /** counter += n; for n > 0 refuses (false) if the result would exceed limit; n < 0 refunds (never below 0). */
  addN(key: string, n: number, limit: number, ttlSec: number): Promise<boolean>;
  count(key: string): Promise<number>;                                // current counter value (0 if none)
  incr(key: string): Promise<number>;
  recordSettlement(txKey: string, ttlSec: number, counterKey: string): Promise<number>; // -1 if tx replayed, else new count                                 // permanent counter, returns new value                              // all pre-payment checks in ONE call
}

type Entry = { n: number; exp: number };

export class Guard extends DurableObject implements GuardApi {
  private async get(key: string): Promise<Entry | undefined> {
    const e = await this.ctx.storage.get<Entry>(key);
    if (e && e.exp < Date.now()) { await this.ctx.storage.delete(key); return undefined; }
    return e;
  }
  async take(key: string, limit: number, ttlSec: number) {
    const e = (await this.get(key)) ?? { n: 0, exp: Date.now() + ttlSec * 1000 };
    if (e.n >= limit) return false;
    e.n++; await this.ctx.storage.put(key, e); return true;
  }
  async peek(key: string, limit: number) { return ((await this.get(key))?.n ?? 0) < limit; }
  async claimOnce(key: string, ttlSec: number) {
    if (await this.get(key)) return false;
    await this.ctx.storage.put(key, { n: 1, exp: Date.now() + ttlSec * 1000 });
    return true;
  }
  async admit(a: Admit) { return runAdmit(this, a); }
  async trial(t: Trial) { return runTrial(this, t); }
  async addN(key: string, n: number, limit: number, ttlSec: number) {
    const e = (await this.get(key)) ?? { n: 0, exp: Date.now() + ttlSec * 1000 };
    if (n > 0 && e.n + n > limit) return false;
    e.n = Math.max(0, e.n + n); await this.ctx.storage.put(key, e); return true;
  }
  async recordSettlement(txKey: string, ttlSec: number, counterKey: string) {
    if (!(await this.claimOnce(txKey, ttlSec))) return -1;
    return this.incr(counterKey);
  }
  async count(key: string) { return (await this.get(key))?.n ?? 0; }
  async incr(key: string) {
    const e = (await this.get(key)) ?? { n: 0, exp: Number.MAX_SAFE_INTEGER };
    e.n++; await this.ctx.storage.put(key, e); return e.n;
  }
}

