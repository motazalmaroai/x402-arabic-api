export const FACILITATOR_URLS = { payai: "https://facilitator.payai.network", "x402org-testnet": "https://x402.org/facilitator" } as const;
export const facilitatorName = (f?: string) => (f === "payai" ? "payai" : "x402org");

// All payment terms are fixed SERVER-SIDE. Nothing here is ever read from the client.
export const NETWORKS = {
  // DEFAULT. Official Base Sepolia USDC (Circle: developers.circle.com/stablecoins/usdc-contract-addresses)
  "base-sepolia": { caip2: "eip155:84532", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", eip712: { name: "USDC", version: "2" }, rpcs: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"] },
  // MAINNET — opt-in switch only (X402_NETWORK="base"), after risk-manager sign-off.
  base: { caip2: "eip155:8453", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", eip712: { name: "USD Coin", version: "2" }, rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"] },
} as const;
export type NetworkKey = keyof typeof NETWORKS;

// Prices in USDC atomic units (6 decimals). 0.01 = 10000. OCR (0.10 = 100000) reserved; endpoint not offered.
export const PRICES = { "/translate-ar": "10000", "/summarize-ar": "20000", "/dialect-to-msa": "10000", "/localize-ar-json": "20000" } as const;
export type PaidPath = keyof typeof PRICES;

export const MAX_INPUT_CHARS = 4000;
export const MAX_BODY_BYTES = 16 * 1024;
export const LOCALIZE_MAX_BODY_BYTES = 32 * 1024;
export const LOCALIZE_MAX_KEYS = 200;      // string leaves
export const LOCALIZE_MAX_CHARS = 8000;    // sum of string-leaf lengths
export const LOCALIZE_BATCH_CHARS = 2000;  // per model call
export const LOCALIZE_MAX_TOKENS = 2048;   // per model call
export const MAX_OUTPUT_TOKENS = 1024;
// qwen3-30b-a3b-fp8: 4625 neurons/M in, 30475 neurons/M out.
// Worst case per call ≈ 2.5k in (9.3) + 1024 out (31.2) ≈ 41 neurons -> 200 calls ≈ 8.2k < 10k free/day.
export const DEFAULT_DAILY_CAP = 200;

// ---- Workers AI neuron budget (Free plan: 10,000 neurons/day, resets 00:00 UTC) ----
// Every model-calling request RESERVES its worst case in the Guard DO before any model call (and before a 402 is
// issued, as a peek), then refunds the unused part from the model's reported usage. Total reserved/day <= NEURON_BUDGET.
export const NEURONS_PER_IN_TOKEN = 4625 / 1e6;
export const NEURONS_PER_OUT_TOKEN = 30475 / 1e6;
export const neurons = (inTok: number, outTok: number) => inTok * NEURONS_PER_IN_TOKEN + outTok * NEURONS_PER_OUT_TOKEN;
export const DEFAULT_NEURON_BUDGET = 9000; // 10% headroom under the free 10k (quality evals, dashboard tests)
// Worst case per request (input tokens bounded as 1 token/char + ~1k prompt/glossary; output = max_tokens; x2 for the one retry).
export const WORST_NEURONS: Record<string, number> = {
  "/translate-ar": Math.ceil(2 * neurons(MAX_INPUT_CHARS + 1000, MAX_OUTPUT_TOKENS)),   // 2*(23.1+31.2) = 109
  "/dialect-to-msa": Math.ceil(2 * neurons(MAX_INPUT_CHARS + 1000, MAX_OUTPUT_TOKENS)), // 109
  "/summarize-ar": Math.ceil(2 * neurons(MAX_INPUT_CHARS + 1000, MAX_OUTPUT_TOKENS)),   // 109
  // 4 batches of <=2000 chars, each retried at most once => 8 calls * (2400 in, 2048 out) = 8*73.5 = 588
  "/localize-ar-json": Math.ceil(2 * Math.ceil(LOCALIZE_MAX_CHARS / LOCALIZE_BATCH_CHARS) * neurons(LOCALIZE_BATCH_CHARS + 400, LOCALIZE_MAX_TOKENS)),
};

// ---- Free trial: POST /try/translate-ar (Guard DO counters; no paid binding) ----
export const TRIAL_MAX_CHARS = 200;
export const TRIAL_MAX_TOKENS = 256;
export const TRIAL_PER_IP_PER_DAY = 5;
export const DEFAULT_TRIAL_DAILY_CAP = 100;
// Settlement stop: once the cumulative facilitator settlement counter reaches this, paid routes answer 503 BEFORE any 402.
// Raise it via the SETTLE_STOP var (e.g. "1500") or set "0" to disable the stop.
export const DEFAULT_SETTLE_STOP = 900;
// 1 call, no retry: <=600 input tokens (200 chars + system prompt) and <=256 output tokens => 2.78 + 7.80 = 10.6
export const TRIAL_WORST_NEURONS = Math.ceil(neurons(600, TRIAL_MAX_TOKENS)); // 11
export const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
export const IP_LIMIT_PER_MIN = 20;
export const PAYER_LIMIT_PER_MIN = 10;

export interface Env {
  AI: { run(model: string, input: unknown): Promise<any> };
  GUARD: DurableObjectNamespace;
  X402_NETWORK?: string;      // "base-sepolia" (default) | "base"
  PAY_TO?: string;            // receive address; unset => paid routes return 503
  FACILITATOR?: string;       // "payai" (mainnet, keyless) | "x402org-testnet" (Sepolia only)
  DAILY_CAP?: string;
  NEURON_BUDGET?: string;     // daily Workers AI neuron reservation ceiling (default 9000)
  TRIAL_DAILY_CAP?: string;   // global free-trial calls/day (default 100); "0" disables the trial
  SETTLE_STOP?: string;       // paid routes 503 once settlements >= this (default 900); "0" disables
  REDEEM?: KVNamespace;       // lost-response redeem store (required for paid routes)
}

export function resolveNetwork(env: Env) {
  const key = (env.X402_NETWORK ?? "base-sepolia") as NetworkKey;
  const n = NETWORKS[key];
  if (!n) throw new Error("bad X402_NETWORK");
  return n;
}
export const OCR_PRICE_RESERVED = "100000";

/** Expected (network, asset) pairs — compared against the resolved config before serving paid routes. */
const EXPECTED = { "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } as const;

/** Mainnet receive address pinned in code (risk-manager approved). A wrangler var typo cannot redirect funds. */
export const APPROVED_MAINNET_PAY_TO = "0x5cb7Cc71c117675ef36102eaed7a5Aa78A29B29a";

/** Returns a reason string if paid routes must NOT be served, else null. Mainnet is strict. */
export function paymentConfigError(env: Env): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO ?? "")) return "pay_to_not_configured";
  if (!env.REDEEM) return "redeem_store_not_configured"; // lost-response redeem is mandatory for paid routes
  let n; try { n = resolveNetwork(env); } catch { return "bad_network"; }
  if ((EXPECTED as any)[n.caip2] !== n.usdc) return "asset_network_mismatch";
  if (n.caip2 === "eip155:8453") {
    if (env.X402_NETWORK !== "base") return "asset_network_mismatch";
    if (n.usdc !== "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" || n.eip712.name !== "USD Coin") return "asset_network_mismatch";
    if (env.PAY_TO!.toLowerCase() !== APPROVED_MAINNET_PAY_TO.toLowerCase()) return "pay_to_not_approved";
    if (env.FACILITATOR !== "payai") return "mainnet_requires_payai";
  } else if (env.FACILITATOR !== "x402org-testnet" && env.FACILITATOR !== "payai") return "bad_facilitator";
  return null;
}
