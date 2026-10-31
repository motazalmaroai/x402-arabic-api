import { it, expect } from "vitest";
import { warmUp } from "../src/warmup";
it("warm-up runs fully in memory and resolves (no network, no throw)", async () => {
  const orig = globalThis.fetch; let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error("no I/O in warm-up"); }) as any;
  let st; try { st = await warmUp({ X402_NETWORK: "base-sepolia", PAY_TO: "0x" + "44".repeat(20), FACILITATOR: "x402org-testnet" } as any); }
  finally { globalThis.fetch = orig; }
  expect(fetched).toBe(0);
  expect(st).toEqual([402, 200]);
});
