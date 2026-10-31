# x402-arabic-mcp

A small stdio MCP server for the [x402 Arabic API](https://arabic-x402-api-base.motaz-crypto.workers.dev/openapi.json). It gives an agent:

| Tool | What it does | Price per call |
|---|---|---|
| `translate_ar(text, direction?)` | Modern Standard Arabic <-> English. `direction`: `auto` (default), `ar-en`, `en-ar`. | 0.05 USDC |
| `summarize_ar(text, length?)` | Arabic (MSA) summary of Arabic or English text. `length`: `short`, `medium` (default), `long`. | 0.07 USDC |
| `api_info()` | Reads the free `/.well-known/x402` pricing manifest. | free |

`text` is 1–4000 characters. Payment uses x402 v2 (`exact` scheme) in USDC on Base mainnet (`eip155:8453`), via the official `@x402/fetch` + `@x402/evm` client libraries.

## Install

Requires Node.js 20 or later.

```bash
npx -y x402-arabic-mcp      # once published to npm
# or from a clone of this repo:
cd mcp && npm install && npm run build && node dist/index.js
```

## Claude Desktop / Cursor config

`claude_desktop_config.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "arabic": {
      "command": "npx",
      "args": ["-y", "x402-arabic-mcp"],
      "env": {
        "EVM_PRIVATE_KEY": "0x<your own wallet key>",
        "MAX_PAYMENT_USDC": "0.10",
        "MAX_TOTAL_USDC": "0.50"
      }
    }
  }
}
```

From a local clone, use `"command": "node", "args": ["/path/to/mcp/dist/index.js"]`.

## Environment variables

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `EVM_PRIVATE_KEY` | no | unset | Key of **your own** Base wallet holding USDC. If unset, paid tools pay nothing and only return the price. |
| `MAX_PAYMENT_USDC` | no | `0.10` | Per-call cap. A call is refused if the quoted amount is higher. |
| `MAX_TOTAL_USDC` | no | `0.50` | Session cap: total spent by this server process since it started. A payment that would push the total above it is refused. Resets when the process restarts. |
| `ARABIC_API_URL` | no | live API URL | Override the base URL (for testing). |

## Safety

- The key stays on your machine, in this process's env. It is used only to sign an x402 USDC authorization; nothing else is sent anywhere. The API operator never sees or stores it.
- Use a dedicated wallet holding only a small amount of USDC.
- **The key is stored as plain text** in your MCP client's config file (e.g. `claude_desktop_config.json` or `.cursor/mcp.json`). Anyone or anything that can read that file can take the funds. Keep only a small amount in this wallet and never use your main wallet.
- Before signing, every call first makes an unpaid request and checks the 402 terms. It refuses unless they match exactly: scheme `exact`, network `eip155:8453`, asset USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, payTo `0x5cb7Cc71c117675ef36102eaed7a5Aa78A29B29a`, amount ≤ `MAX_PAYMENT_USDC`, and the session total stays ≤ `MAX_TOTAL_USDC` (spend is reserved before paying and released if the call fails). The same check runs again as an x402 client policy on the paying request.
- Without `EVM_PRIVATE_KEY`, no payment is ever made.
- Each paid call costs the listed price. Paid results are model output (machine translation and summarization), so check anything important.

## Development

```bash
npm install
npm test               # build + unit tests for the per-call cap, session cap and mismatch checks (mocked 402)
node test/smoke.mjs    # starts the server without a key, lists tools, calls them (pays nothing)
```

License: MIT
