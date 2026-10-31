import type { GuardApi } from "./guard";
import { runAdmit, runTrial, type Admit, type Trial } from "./admit";

/** In-memory guard: used by tests and by the startup warm-up (never for real traffic). */
type Entry = { n: number; exp: number };
export class MemoryGuard implements GuardApi {
  m = new Map<string, Entry>();
  private g(k: string) { const e = this.m.get(k); if (e && e.exp < Date.now()) { this.m.delete(k); return; } return e; }
  async take(k: string, limit: number, ttl: number) { const e = this.g(k) ?? { n: 0, exp: Date.now() + ttl * 1000 }; if (e.n >= limit) return false; e.n++; this.m.set(k, e); return true; }
  async peek(k: string, limit: number) { return (this.g(k)?.n ?? 0) < limit; }
  async claimOnce(k: string, ttl: number) { if (this.g(k)) return false; this.m.set(k, { n: 1, exp: Date.now() + ttl * 1000 }); return true; }
  async admit(a: Admit) { return runAdmit(this, a); }
  async trial(t: Trial) { return runTrial(this, t); }
  async addN(k: string, n: number, limit: number, ttl: number) { const e = this.g(k) ?? { n: 0, exp: Date.now() + ttl * 1000 }; if (n > 0 && e.n + n > limit) return false; e.n = Math.max(0, e.n + n); this.m.set(k, e); return true; }
  async recordSettlement(t: string, ttl: number, k: string) { if (!(await this.claimOnce(t, ttl))) return -1; return this.incr(k); }
  async count(k: string) { return this.g(k)?.n ?? 0; }
  async incr(k: string) { const e = this.g(k) ?? { n: 0, exp: Number.MAX_SAFE_INTEGER }; e.n++; this.m.set(k, e); return e.n; }
}

