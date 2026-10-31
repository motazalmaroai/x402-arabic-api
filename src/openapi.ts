import { type Env, PRICES, MAX_INPUT_CHARS, resolveNetwork } from "./config";
import { translateInput, translateOutput, summarizeInput, summarizeOutput, errorSchema, examples } from "./schemas";

export function buildOpenApi(env: Env, origin: string) {
  const net = resolveNetwork(env);
  const errs = (extra: Record<string, string> = {}) => Object.fromEntries(Object.entries({
    "400": "Invalid JSON or input.", "402": "Payment required. x402 v2 requirements in the PAYMENT-REQUIRED header (base64 JSON).",
    "409": "Payment authorization already used (replay).", "413": `Body > 16 KiB or text > ${MAX_INPUT_CHARS} chars.`,
    "429": "Rate limited (per IP or per payer).", "503": "Daily capacity reached or payments not configured. Not charged.", ...extra,
  }).map(([k, d]) => [k, { description: d, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }]));
  const pay = (amount: string) => ({ scheme: "exact", network: net.caip2, asset: net.usdc, amount, decimals: 6, usd: Number(amount) / 1e6 });
  const xpi = (amount: string) => ({ protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: (Number(amount) / 1e6).toFixed(2) } });
  return {
    openapi: "3.1.0",
    info: { title: "x402 Arabic API", version: "1.0.0", description: "Arabic<->English translation and Arabic summarization, paid per request with x402 (USDC). Lost response: resend the IDENTICAL payment header to the same endpoint within 1 hour to get the same stored response (200, no second charge); any other payment reuse returns 409." },
    servers: [{ url: origin }],
    paths: {
      "/translate-ar": { post: {
        operationId: "translateArabic", summary: "Translate Arabic<->English",
        description: "Use when: you need Modern Standard Arabic to English or English to Arabic translation; direction is auto-detected unless given. Addresses, numbers and code are preserved verbatim.",
        "x-x402": pay(PRICES["/translate-ar"]), "x-payment-info": xpi(PRICES["/translate-ar"]),
        requestBody: { required: true, content: { "application/json": { schema: translateInput, example: examples.translate.req } } },
        responses: { "200": { description: "Translation", content: { "application/json": { schema: translateOutput, example: examples.translate.res } } }, ...errs() },
      } },
      "/summarize-ar": { post: {
        operationId: "summarizeArabic", summary: "Arabic summary of Arabic or English text",
        description: "Use when: you need a faithful Modern Standard Arabic summary of Arabic or English text at a chosen length.",
        "x-x402": pay(PRICES["/summarize-ar"]), "x-payment-info": xpi(PRICES["/summarize-ar"]),
        requestBody: { required: true, content: { "application/json": { schema: summarizeInput, example: examples.summarize.req } } },
        responses: { "200": { description: "Summary", content: { "application/json": { schema: summarizeOutput, example: examples.summarize.res } } }, ...errs() },
      } },
      "/health": { get: { operationId: "health", description: "Use when: checking liveness. Free.", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } } } },
      "/openapi.json": { get: { operationId: "openapi", description: "Use when: discovering this API's contract. Free.", responses: { "200": { description: "This document", content: { "application/json": { schema: { type: "object" } } } } } } },
      "/.well-known/x402": { get: { operationId: "x402Manifest", description: "Use when: listing paid resources and prices. Free, informational.", responses: { "200": { description: "Manifest", content: { "application/json": { schema: { type: "object" } } } } } } },
    },
    components: { schemas: { Error: errorSchema } },
  };
}
