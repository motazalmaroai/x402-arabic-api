#!/usr/bin/env node
// One real paid /translate-ar call on Base Sepolia, then a replay of the same payment header (must be rejected).
// Usage: node scripts/pay-test.mjs [baseUrl]   (buyer key read at runtime from BUYER_KEY_FILE; never printed)
import { readFileSync } from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.argv[2] ?? "https://arabic-x402-api.motaz-crypto.workers.dev";
const KEY_FILE = process.env.BUYER_KEY_FILE;
if (!KEY_FILE) throw new Error("set BUYER_KEY_FILE to a local, untracked testnet key file");
const URL_ = `${BASE}/translate-ar`;
const BODY = JSON.stringify({ text: "تُعدّ الشفافية أحد المبادئ الأساسية لتقنية البلوكتشين.", direction: "ar-en" });
const SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

const account = privateKeyToAccount(JSON.parse(readFileSync(KEY_FILE, "utf8")).privateKey);
console.log("buyer:", account.address);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const http = new x402HTTPClient(client);
const post = (headers = {}) => fetch(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: BODY });

// 1) Unpaid -> 402 and strict checks before signing anything.
const r1 = await post();
if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}`);
const required = http.getPaymentRequiredResponse((h) => r1.headers.get(h), await r1.json().catch(() => undefined));
const a = required.accepts;
if (a.length !== 1) throw new Error(`expected exactly one payment option, got ${a.length}`);
const [req] = a;
if (req.network !== "eip155:84532") throw new Error(`refusing: network ${req.network} is not Base Sepolia`);
if (req.amount !== "50000") throw new Error(`refusing: amount ${req.amount} != 50000`);
if (req.asset.toLowerCase() !== SEPOLIA_USDC) throw new Error(`refusing: asset ${req.asset}`);
console.log("402 ok:", { network: req.network, amount: req.amount, asset: req.asset, payTo: req.payTo });

if (process.env.DRY_RUN) { console.log("DRY_RUN: stopping before signing."); process.exit(0); }

// 2) Sign (EIP-3009, gasless for the buyer) and pay.
const payload = await http.createPaymentPayload(required);
const payHeaders = http.encodePaymentSignatureHeader(payload);
const r2 = await post(payHeaders);
console.log("paid status:", r2.status);
console.log("response:", await r2.text());
const pr = r2.headers.get("PAYMENT-RESPONSE") ?? r2.headers.get("X-PAYMENT-RESPONSE");
console.log("PAYMENT-RESPONSE header:", pr);
if (pr) {
  const settle = http.getPaymentSettleResponse((h) => r2.headers.get(h));
  console.log("settlement:", JSON.stringify(settle));
  console.log("settlement tx hash:", settle.transaction, `https://sepolia.basescan.org/tx/${settle.transaction}`);
}

// 3) Replay the exact same payment header -> must be 409 (or 402).
const r3 = await post(payHeaders);
console.log("identical-header replay (expect 200 redeemed):", r3.status, await r3.text());
console.log(r3.status === 409 || r3.status === 402 ? "REPLAY REJECTED ✅" : "REPLAY NOT REJECTED ❌");
process.exit(r2.status === 200 && (r3.status === 409 || r3.status === 402) ? 0 : 1);
