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

// Prices in USDC atomic units (6 decimals). 0.05 = 50000. OCR (0.10 = 100000) reserved; endpoint not offered.
export const PRICES = { "/translate-ar": "50000", "/summarize-ar": "70000" } as const;

export const MAX_INPUT_CHARS = 4000;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_OUTPUT_TOKENS = 1024;
// qwen3-30b-a3b-fp8: 4625 neurons/M in, 30475 neurons/M out.
// Worst case per call ≈ 2.5k in (9.3) + 1024 out (31.2) ≈ 41 neurons -> 200 calls ≈ 8.2k < 10k free/day.
export const DEFAULT_DAILY_CAP = 200;
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
