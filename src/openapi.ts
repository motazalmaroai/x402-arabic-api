import { type Env, PRICES, MAX_INPUT_CHARS, resolveNetwork, TRIAL_MAX_CHARS, TRIAL_PER_IP_PER_DAY } from "./config";
import { errorSchema, examples, trialInput, trialOutput } from "./schemas";
import { ROUTE_DOCS, TAGS } from "./app";

const OPS: Record<string, { operationId: string; summary: string; use: string }> = {
  "/translate-ar": { operationId: "translateArabic", summary: "Translate Arabic<->English (optional Web3 glossary)", use: "Use when: you need Arabic<->English translation (MSA or Saudi/Gulf dialect input) that keeps 0x addresses, numbers, URLs and code verbatim; set glossary=web3 for fixed Arabic Web3 terminology." },
  "/summarize-ar": { operationId: "summarizeArabic", summary: "Arabic summary of Arabic or English text", use: "Use when: you need a faithful Modern Standard Arabic summary of Arabic or English text at a chosen length, without invented numbers or addresses." },
  "/dialect-to-msa": { operationId: "dialectToMsa", summary: "Saudi/Gulf dialect <-> Modern Standard Arabic", use: "Use when: you need Saudi/Gulf dialect Arabic rewritten as formal MSA (فصحى), or MSA rewritten as natural Saudi/Gulf dialect." },
  "/localize-ar-json": { operationId: "localizeArabicJson", summary: "Localize an i18n JSON object to Arabic", use: "Use when: you need an app's i18n JSON localized to Arabic with keys unchanged and placeholders ({name}, {{count}}, %s, ICU plurals, HTML tags) validated per string." },
};

export function buildOpenApi(env: Env, origin: string) {
  const net = resolveNetwork(env);
  const errs = (extra: Record<string, string> = {}) => Object.fromEntries(Object.entries({
    "400": "Invalid JSON or input.", "402": "Payment required. x402 v2 requirements in the PAYMENT-REQUIRED header (base64 JSON).",
    "409": "Payment authorization already used (replay).", "413": `Body > 16 KiB (32 KiB for /localize-ar-json), text > ${MAX_INPUT_CHARS} chars, or > 200 strings / 8000 chars for /localize-ar-json.`,
    "429": "Rate limited (per IP or per payer).", "503": "Daily capacity reached or payments not configured. Not charged.", ...extra,
  }).map(([k, d]) => [k, { description: d, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }]));
  const pay = (amount: string) => ({ scheme: "exact", network: net.caip2, asset: net.usdc, amount, decimals: 6, usd: Number(amount) / 1e6 });
  const xpi = (amount: string) => ({ protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: (Number(amount) / 1e6).toFixed(2) } });
  return {
    openapi: "3.1.0",
    info: { title: "x402 Arabic API", version: "1.1.0", description: "Arabic-native, Gulf-dialect aware Arabic API for agents: Arabic<->English translation (optional Web3 glossary), Arabic summarization, Saudi/Gulf dialect<->MSA conversion and i18n JSON localization. Keeps 0x addresses, numbers, URLs and code verbatim. Paid per request with x402 (USDC). Lost response: resend the IDENTICAL payment header to the same endpoint within 1 hour to get the same stored response (200, no second charge); any other payment reuse returns 409.",
      "x-guidance": `Arabic-native, Gulf-dialect aware Arabic API; 0x addresses, URLs and numbers are kept verbatim and post-checked. POST JSON to /translate-ar ({text, direction?, glossary?:"web3"}), /summarize-ar ({text, length?}), /dialect-to-msa ({text, direction?:"dialect-msa"|"msa-dialect", dialect?:"saudi"|"gulf"}) or /localize-ar-json ({json}). Free trial: POST /try/translate-ar (<= ${TRIAL_MAX_CHARS} chars, ${TRIAL_PER_IP_PER_DAY}/IP/day). An unpaid request returns 402 with x402 v2 payment requirements (exact scheme, USDC) in the PAYMENT-REQUIRED header; sign them and resend the same request with the PAYMENT-SIGNATURE header. Max ${MAX_INPUT_CHARS} chars of text, 16 KiB body. /health, /openapi.json and /.well-known/x402 are free.` },
    servers: [{ url: origin }],
    paths: {
      ...Object.fromEntries(Object.entries(ROUTE_DOCS).map(([path, d]) => [path, { post: {
        operationId: OPS[path].operationId, summary: OPS[path].summary, tags: TAGS,
        description: `${OPS[path].use} ${d.description}`,
        "x-x402": pay((PRICES as any)[path]), "x-payment-info": xpi((PRICES as any)[path]),
        requestBody: { required: true, content: { "application/json": { schema: d.input, example: d.ex.req } } },
        responses: { "200": { description: "OK", content: { "application/json": { schema: d.output, example: d.ex.res } } }, ...errs({ "502": "Model error, or the model altered a 0x address/URL twice. Not charged." }) },
      } }])),
      "/try/translate-ar": { post: {
        operationId: "tryTranslateArabic", security: [], tags: TAGS, summary: "Free trial translation (short text)",
        description: `Use when: you want to try the translation quality for free before paying. Max ${TRIAL_MAX_CHARS} chars, ${TRIAL_PER_IP_PER_DAY} calls per IP per UTC day and a global daily cap; 429 above the limits. No payment, no glossary.`,
        requestBody: { required: true, content: { "application/json": { schema: trialInput, example: examples.trial.req } } },
        responses: { "200": { description: "Translation", content: { "application/json": { schema: trialOutput, example: examples.trial.res } } },
          "400": { description: "Invalid input." }, "413": { description: `Text > ${TRIAL_MAX_CHARS} chars.` }, "429": { description: "Free trial limit reached (per IP or global)." }, "502": { description: "Model error." } },
      } },
      "/health": { get: { operationId: "health", security: [], description: "Use when: checking liveness. Free.", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } } } },
      "/openapi.json": { get: { operationId: "openapi", security: [], description: "Use when: discovering this API's contract. Free.", responses: { "200": { description: "This document", content: { "application/json": { schema: { type: "object" } } } } } } },
      "/.well-known/x402": { get: { operationId: "x402Manifest", security: [], description: "Use when: listing paid resources and prices. Free, informational.", responses: { "200": { description: "Manifest", content: { "application/json": { schema: { type: "object" } } } } } } },
    },
    components: { schemas: { Error: errorSchema } },
  };
}
