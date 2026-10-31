# x402 Arabic API

Pay-per-call Arabic ⇄ English translation and Arabic summarization for AI agents, paid in USDC via [x402](https://www.x402.org/). No account and no API key are needed. Runs on Cloudflare Workers and Workers AI (`@cf/qwen/qwen3-30b-a3b-fp8`, Apache-2.0).

## Endpoints

| Endpoint | Price | Use when |
|---|---|---|
| `POST /translate-ar` | **0.05 USDC** | Use when: an agent needs accurate MSA Arabic⇄English translation that preserves wallet addresses, numbers, URLs and code verbatim; direction is auto-detected or set via `direction` (`ar-en`/`en-ar`). |
| `POST /summarize-ar` | **0.07 USDC** | Use when: an agent needs a faithful Arabic summary (`length`: `short`/`medium`/`long`) of Arabic or English text up to 4,000 characters. |
| `/arabic-ocr` | 0.10 USDC (reserved) | Not offered yet; returns 404. |
| `GET /`, `/openapi.json`, `/.well-known/x402`, `/health` | free | Docs and discovery. |

Limits: 4,000 characters of input, a 16 KiB body, and a daily call cap (503 *before* you pay). Rate limits apply per IP and per payer (429). A replayed payment returns 409. The network is Base (`eip155:8453`) USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, or Base Sepolia on testnet deployments; check `/health`.

You are charged only on success. The response is returned only after the facilitator **verifies and settles** the payment. If the model fails, the cap is hit, or settlement fails, nothing is settled.

### Payment rules
- **Scheme `exact` only**, USDC on Base. `payTo`, price, network and asset are fixed server-side.
- **Facilitator:** Base mainnet uses **PayAI only** (`https://facilitator.payai.network`, keyless). Base Sepolia uses `https://x402.org/facilitator`. There is no fallback facilitator.
- **Order:** verify → generate (the response body is fully built) → settle → on-chain receipt check → respond.
- **Receipt check:** the tx must have status 1, a USDC `Transfer` log to `payTo` for the exact amount, and a tx hash never seen before.
- **If the facilitator (verify/settle) or the receipt RPC is unavailable or errors:** `503 {"error":"facilitator_unavailable"}` with no paid content, and the payment is never settled elsewhere. Other settle or receipt failures return `402` with no body.
- `/health` shows the facilitator and successful settlements per facilitator. A warning is logged at 900 PayAI settlements.
- Replay protection covers both the payment nonce (`409`) and the tx hash. Rate limits apply per IP and per payer. Paid attempts reserve daily capacity before generation.


## curl

```bash
BASE=https://<worker>.workers.dev
curl -s -i -X POST $BASE/translate-ar -H 'content-type: application/json' \
  -d '{"text":"تُعدّ الشفافية أحد المبادئ الأساسية لتقنية البلوكتشين."}'
# -> HTTP 402 with a PAYMENT-REQUIRED header (base64 JSON). Decode it:
curl -s -D - -o /dev/null -X POST $BASE/translate-ar -H 'content-type: application/json' -d '{"text":"hi"}' \
  | grep -i '^payment-required' | cut -d' ' -f2 | tr -d '\r' | base64 -d | jq .
```

## x402 client (TypeScript)

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.BUYER_KEY as `0x${string}`) });
const pay = wrapFetchWithPayment(fetch, client);

const r = await pay("https://<worker>.workers.dev/summarize-ar", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "Long article…", length: "short" }),
});
console.log(await r.json()); // { summary, length, model }
```

## Develop

```bash
npm ci && npm test            # vitest (fake facilitator, mock AI)
cp .dev.vars.example .dev.vars && npx wrangler dev   # local; AI calls need `wrangler login`
node scripts/quality-eval.mjs # model quality eval (needs CLOUDFLARE_ACCOUNT_ID/API_TOKEN)
```

See [DEPLOY.md](DEPLOY.md). MIT licensed.

## Lost-response redeem (KV)
- Every paid request is checked by hand before verify: x402Version 2, scheme `exact`, network, asset, payTo, amount, authorization to/value, validAfter/validBefore, nonce (32-byte hex), signature (hex ≥65 bytes). Failure → 400 `invalid_payment`.
- After generation and **before settle**, `{h: sha256(full payment header), path, body}` is stored in KV `REDEEM` under `redeem:sha256(chainId|asset|from|nonce)` with TTL 3600 s. The input text is never stored. A KV write failure → 503 and no settle.
- A resend of the **identical** header within 1 h returns the stored body (200, `x-x402-redeemed: true`, no new settle), but only if `authorizationState(from, nonce)` on-chain is true. A different payload, a different path, no stored entry, or an unused nonce → 409. RPC or KV down → 503.
- Tests: `scripts/lost-response-test.mjs` (Sepolia).
