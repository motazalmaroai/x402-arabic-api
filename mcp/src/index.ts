#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { amountOf, capAtomic, checkRequirement, decodePaymentRequired, filterRequirements, formatUsdc, SessionBudget, totalCapAtomic } from "./guard.js";

let budget: SessionBudget | null = null;
function getBudget(): SessionBudget { return (budget ??= new SessionBudget(totalCapAtomic())); }

const BASE = (process.env.ARABIC_API_URL || "https://arabic-x402-api-base.motaz-crypto.workers.dev").replace(/\/$/, "");

type Fetch = typeof fetch;
let payingFetch: Fetch | null | undefined;

/** Built lazily, only if the user set EVM_PRIVATE_KEY on their own machine. */
async function getPayingFetch(): Promise<Fetch | null> {
  if (payingFetch !== undefined) return payingFetch;
  const key = process.env.EVM_PRIVATE_KEY?.trim();
  if (!key) return (payingFetch = null);
  const { wrapFetchWithPaymentFromConfig } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm");
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
  const cap = capAtomic();
  payingFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
    // Defence in depth: the library may only pick requirements that pass our checks.
    // Note: the reservation for this call is already held, so the total check here uses the reserved state.
    policies: [(_v: number, reqs: any[]) => filterRequirements(reqs, cap).filter((r) => amountOf(r) + getBudget().spent <= getBudget().totalCap && getBudget().spent + getBudget().reserved <= getBudget().totalCap)],
  } as any) as Fetch;
  return payingFetch;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

async function callPaid(path: string, body: Record<string, unknown>) {
  const url = `${BASE}${path}`;
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  // 1) Unpaid probe: never pays. Read and verify the 402 terms first.
  const probe = await fetch(url, init);
  if (probe.status !== 402) return text(`Unexpected status ${probe.status} (no payment made): ${await probe.text()}`, !probe.ok);
  let pr;
  try { pr = decodePaymentRequired(probe.headers.get("payment-required")); }
  catch (e) { return text(`Refused, no payment made: ${(e as Error).message}`, true); }
  let cap: bigint;
  let b: SessionBudget;
  try { cap = capAtomic(); b = getBudget(); } catch (e) { return text(`Refused: ${(e as Error).message}`, true); }
  const reasons = pr.accepts.map((r) => checkRequirement(r, cap));
  const ok = pr.accepts.filter((_, i) => reasons[i] === null);
  const terms = JSON.stringify(pr.accepts.map(({ scheme, network, amount, asset, payTo }) => ({ scheme, network, amount, asset, payTo })));
  if (ok.length > 0 && b.check(amountOf(ok[0])) !== null) return text(`Refused, no payment made: ${b.check(amountOf(ok[0]))}. Terms: ${terms}`, true);
  if (ok.length === 0) return text(`Refused, no payment made. ${reasons.filter(Boolean).join("; ")}. Terms: ${terms}`, true);
  // 2) No key configured: report the price and stop.
  const pf = await getPayingFetch();
  if (!pf) {
    return text(`Payment required: ${formatUsdc(BigInt(ok[0].amount as string))} on Base (eip155:8453). No payment made because EVM_PRIVATE_KEY is not set. Set it in this MCP server's env (your own wallet, holding Base USDC) to enable paid calls. Terms: ${terms}`, true);
  }
  // 3) Reserve against the session total cap, then pay with the user's own key via the official x402 client.
  const amt = amountOf(ok[0]);
  const why = b.reserve(amt);
  if (why) return text(`Refused, no payment made: ${why}. Terms: ${terms}`, true);
  let res: Response, out: string;
  try { res = await pf(url, init); out = await res.text(); }
  catch (e) { b.release(amt); return text(`Payment/request failed: ${(e as Error).message}`, true); }
  if (!res.ok) { b.release(amt); return text(`API error ${res.status}: ${out}`, true); }
  b.commit(amt);
  const receipt = res.headers.get("payment-response");
  return text(out + (receipt ? `\n\n[x402 receipt header present: PAYMENT-RESPONSE]` : ""));
}

const server = new McpServer({ name: "x402-arabic-api", version: "0.1.0" });

server.tool(
  "translate_ar",
  "Translate Modern Standard Arabic <-> English via the x402 Arabic API. Paid: 0.05 USDC on Base per call, signed with your own wallet (EVM_PRIVATE_KEY). Refuses if price exceeds MAX_PAYMENT_USDC or terms don't match.",
  {
    text: z.string().min(1).max(4000).describe("Text to translate (Arabic or English)."),
    direction: z.enum(["auto", "ar-en", "en-ar"]).optional().describe("auto (default) detects from script."),
  },
  async ({ text: t, direction }) => callPaid("/translate-ar", direction ? { text: t, direction } : { text: t }),
);

server.tool(
  "summarize_ar",
  "Summarize Arabic or English text into Modern Standard Arabic via the x402 Arabic API. Paid: 0.07 USDC on Base per call, signed with your own wallet (EVM_PRIVATE_KEY). Refuses if price exceeds MAX_PAYMENT_USDC or terms don't match.",
  {
    text: z.string().min(1).max(4000).describe("Arabic or English text to summarize."),
    length: z.enum(["short", "medium", "long"]).optional().describe("short≈1-2 sentences, medium (default)≈3-5, long≈1-2 paragraphs."),
  },
  async ({ text: t, length }) => callPaid("/summarize-ar", length ? { text: t, length } : { text: t }),
);

server.tool("api_info", "Free: read the API's /.well-known/x402 pricing manifest. No payment.", {}, async () => {
  const r = await fetch(`${BASE}/.well-known/x402`);
  return text(await r.text(), !r.ok);
});

await server.connect(new StdioServerTransport());
