import { env as globalEnv } from "cloudflare:workers";
import { createApp, buildPayment, defaultFacilitator, type Payment } from "./app";
import { paymentConfigError, type Env } from "./config";
import type { GuardApi } from "./guard";
import { warmUp } from "./warmup";
export { Guard } from "./guard";

// Build the x402 pipeline at MODULE SCOPE (isolate startup), so route compilation and Bazaar schema
// validation (ajv) are not billed to the first request's CPU time. Only built if the config is valid.
const startEnv = globalEnv as unknown as Env;
const guardOf = (env: Env) => env.GUARD.get(env.GUARD.idFromName("global")) as unknown as GuardApi;
let payment: Payment | null = null;
let buildError: unknown = null;
if (!paymentConfigError(startEnv)) {
  try { payment = buildPayment(startEnv, defaultFacilitator(startEnv, () => guardOf(startEnv))); } catch (e) { buildError = e; }
  warmUp(startEnv); // in-memory only; compiles hot code paths during startup instead of the first paid request
}

const app = createApp({
  guard: guardOf,
  payment: () => { if (!payment) throw buildError ?? new Error("payments disabled"); return payment; },
});
export default app;
