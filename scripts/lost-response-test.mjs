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
const hdrName = Object.keys(payHeaders)[0];
const bal = async () => { const r = await fetch("https://sepolia.base.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SEPOLIA_USDC, data: "0x70a08231" + account.address.slice(2).toLowerCase().padStart(64, "0") }, "latest"] }) }); return BigInt((await r.json()).result); };
const b0 = await bal();
// 3) Pay, then DISCARD the response (simulates the connection dropping after settle).
const r2 = await post(payHeaders);
console.log("first (discarded) status:", r2.status, "tx:", (() => { try { return JSON.parse(atob(r2.headers.get("payment-response"))).transaction; } catch { return null; } })());
await r2.body?.cancel();
// 4) Resend the IDENTICAL header -> expect 200 + same body, no new charge.
const r3 = await post(payHeaders);
const t3 = await r3.text();
console.log("identical resend:", r3.status, "redeemed:", r3.headers.get("x-x402-redeemed"), "body:", t3.slice(0, 120));
// 5) Different payload, same authorization nonce (signature altered) -> expect 409.
const p = JSON.parse(atob(payHeaders[hdrName])); p.payload.signature = "0x" + "ab".repeat(65);
const r4 = await post({ [hdrName]: btoa(JSON.stringify(p)) });
console.log("different payload:", r4.status, (await r4.text()).slice(0, 120));
await new Promise((r) => setTimeout(r, 4000));
console.log("charged (atomic USDC):", (b0 - (await bal())).toString());
