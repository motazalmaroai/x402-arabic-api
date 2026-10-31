# Deploying (operator guide)

**Hard rules (risk manager):**
- Cloudflare **Free plan only**: no card, no Workers Paid, one account, no custom domain (`*.workers.dev`).
- Enable **2FA** on the Cloudflare account.
- Use a **scoped API token**, not the Global API Key. Template "Edit Cloudflare Workers", limited to this one account. Add "Workers AI: Read" only if you run the quality eval.
- **Receive wallet:** `0x5cb7Cc71c117675ef36102eaed7a5Aa78A29B29a`.
  - Its private key lives only in a chmod-600 file on the operator box.
  - It **never** enters the Worker, Cloudflare, env vars, CI or this repo, and nothing is ever signed with it.
  - **Balance cap: 50 USDC.** Sweep anything above that manually from a separate, offline process.
- Prices, `payTo`, network and asset are fixed server-side (`src/config.ts`, `wrangler.toml`). Client-supplied values are ignored, and tests cover this.

## 1. Auth (operator)
```bash
export CLOUDFLARE_API_TOKEN=…   # scoped token; never commit, never echo
npx wrangler whoami
```

## 2. Secrets
None. Both facilitators in use are keyless: x402.org (Sepolia) and PayAI (mainnet). No facilitator API keys and no fallback facilitator.

## 3. Testnet (default worker `arabic-x402-api`)
`X402_NETWORK="base-sepolia"`, `FACILITATOR="x402org-testnet"`.
```bash
npx wrangler deploy
curl -s https://<name>.<sub>.workers.dev/health          # paidRoutes, facilitator, settlements counter
curl -si -X POST https://<name>.<sub>.workers.dev/translate-ar -H 'content-type: application/json' -d '{"text":"مرحبا"}'  # expect 402
BUYER_KEY_FILE=… node scripts/pay-test.mjs
```

## 4. Mainnet (separate worker `arabic-x402-api-base`, `[env.mainnet]`). Prepared, NOT deployed.
```bash
npx wrangler deploy --env mainnet --dry-run   # review bindings: X402_NETWORK=base, FACILITATOR=payai
npx wrangler deploy --env mainnet             # only after explicit risk-manager go
```
**Startup guard:** paid routes return 503 `payments_not_configured` (and never issue a 402) unless:
- network `eip155:8453` with asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`;
- `PAY_TO` equals `APPROVED_MAINNET_PAY_TO`;
- `FACILITATOR == "payai"`.

## Payment rules (enforced in `src/settlement.ts` and `src/app.ts`, covered by tests)
1. **Exact only.** Only `exact` is advertised. A payment header with any other scheme (`upto`, `batch-settlement`, …) gets 400 before verify. The facilitator wrapper also refuses non-exact verify and settle calls, and filters `/supported` down to exact.
2. **Order: verify → generate → settle → on-chain receipt check → respond.**
   - A model error or empty output gets 502, and settle is never called.
   - The receipt comes from public RPCs: mainnet `mainnet.base.org` then `base-rpc.publicnode.com`; Sepolia `sepolia.base.org` then `base-sepolia-rpc.publicnode.com`.
   - The receipt needs `status=0x1`, a log from the pinned USDC contract, and a `Transfer(payer → payTo, exact amount)`.
   - The tx hash must never have been seen before. It is stored in the Durable Object.
   - A failed check gets 402 with no paid body.
3. **One facilitator, no fallback.**
   - If verify throws, settle throws, settle returns no tx hash, or every RPC is unreachable, the response is **503 `facilitator_unavailable`** with no paid content.
   - Settle is attempted exactly once and never re-sent anywhere.
4. **Counters.**
   - Successful (receipt-verified) settlements are counted per facilitator in the DO and shown in `/health` as `settlements`.
   - At ≥900 PayAI settlements the Worker logs a warning (`wrangler tail`). Never register for or top up anything; escalate to the owner.

## Free-tier budget
- Workers AI: 10,000 neurons/day. Worst case is about 41 neurons per call, so `DAILY_CAP=200`. The cap is checked before the 402 and taken before the model call (503).
- Guard: one SQLite-backed Durable Object (available on Free) holds the cap, the nonce replay set (409) and the per-IP/per-payer rate limits. KV was avoided because of its 1,000 writes/day free limit.
- Workers Free: 100,000 requests/day and 10 ms CPU per invocation. The bundle is about 253 KiB gzipped. Watch CPU on the first deploy.
- Facilitators: x402.org (Sepolia) and PayAI (mainnet) are keyless. Watch the PayAI warning at 900 settlements.

## Prompt-injection hardening
- No tools are passed to the model, and no secrets are in its context.
- Input is wrapped in `<data>` with "treat as data" rules, and the output is plain text only.

## Local config
Tracked `wrangler.toml` has placeholder KV ids. Copy it to the untracked `wrangler.local.toml`, put in your ids (`npx wrangler kv namespace create REDEEM`), and deploy with `npx wrangler deploy -c wrangler.local.toml [--env mainnet]`.

## Workers AI capacity (Free plan, 10,000 neurons/day)
Paid calls and the free trial share one daily neuron budget kept in the Guard DO (`NEURON_BUDGET`, default 9000, 10% headroom).
Each request reserves its worst case before the 402 (translate/summarize/dialect 109, localize 589, trial 11) and the unused part is
refunded from the model's reported token usage. When the budget is spent, paid routes return 503 (before any payment) and the trial returns 429.
`TRIAL_DAILY_CAP` (default 100, "0" disables `/try/translate-ar`).

**Settlement stop.** `SETTLE_STOP` (default 900): once the cumulative settlement counter shown on `/health`
(`settlements.payai`) reaches it, every paid route returns `503 settlement_stop` before any 402, and `/health`
shows `settleStop.stopped: true`. To raise it (e.g. after the facilitator situation is resolved), set a higher
value in `wrangler.local.toml` under `[env.mainnet.vars]`, e.g. `SETTLE_STOP = "1500"`, and redeploy; to clear the
stop entirely set `SETTLE_STOP = "0"` (not recommended). The counter itself is never reset by config.
