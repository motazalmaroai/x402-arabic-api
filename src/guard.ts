import { DurableObject } from "cloudflare:workers";
import { runAdmit, type Admit, type AdmitResult } from "./admit";
export type { Admit, AdmitResult };

/** Strongly consistent counters: daily cap, replay nonces, rate limits. Single global instance. */
export interface GuardApi {
  take(key: string, limit: number, ttlSec: number): Promise<boolean>; // counter < limit -> increment, true
  peek(key: string, limit: number): Promise<boolean>;                // true if below limit
  claimOnce(key: string, ttlSec: number): Promise<boolean>;          // false if already claimed (replay)
  admit(a: Admit): Promise<AdmitResult>;
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

