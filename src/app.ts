import { Hono, type Context } from "hono";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { SafeFacilitator, settleKey, PAYAI_WARN_AT } from "./settlement";
import {
  type Env, PRICES, MAX_BODY_BYTES, MAX_INPUT_CHARS, DEFAULT_DAILY_CAP, IP_LIMIT_PER_MIN, PAYER_LIMIT_PER_MIN, MODEL, resolveNetwork, paymentConfigError, FACILITATOR_URLS, facilitatorName,
  LOCALIZE_MAX_BODY_BYTES, WORST_NEURONS, DEFAULT_NEURON_BUDGET, TRIAL_MAX_CHARS, TRIAL_MAX_TOKENS, TRIAL_PER_IP_PER_DAY, DEFAULT_TRIAL_DAILY_CAP, TRIAL_WORST_NEURONS, DEFAULT_SETTLE_STOP,
} from "./config";
import type { GuardApi } from "./guard";
import { translateInput, translateOutput, summarizeInput, summarizeOutput, dialectInput, dialectOutput, localizeInput, localizeOutput, examples } from "./schemas";
import { buildOpenApi } from "./openapi";
import { validatePayment, redeemKey, sha256Hex, REDEEM_TTL_SEC } from "./redeem";
import { detectDirection, translate, summarize, dialectConvert, Meter, DIALECTS } from "./ai";
import { hardFail } from "./verbatim";
import { flatten, localize, type Leaf } from "./localize";
import { GLOSSARIES } from "./glossary";

export interface Payment { mw: (c: any, next: any) => Promise<any>; ready: () => Promise<void>; fac: SafeFacilitator }
export interface Deps {
  guard: (env: Env) => GuardApi;
  /** Pre-built x402 pipeline (built at module scope in production so setup CPU is not billed to requests). */
  payment: (env: Env) => Payment;
}

/**
 * Build the x402 pipeline once. Heavy one-time work (route compilation, Bazaar JSON-schema/ajv validation)
 * happens here; the facilitator /supported fetch is deferred to ready() because I/O is not allowed at global scope.
 */
export function buildPayment(env: Env, fac: SafeFacilitator): Payment {
  const rs = new x402ResourceServer(fac).register(resolveNetwork(env).caip2 as any, new ExactEvmScheme());
  rs.registerExtension(bazaarResourceServerExtension);
  const http = new x402HTTPResourceServer(rs, buildAllRoutes(env));
  const mw = paymentMiddlewareFromHTTPServer(http, undefined, undefined, false);
  let init: Promise<void> | undefined;
  return { mw, fac, ready: () => (init ??= http.initialize().catch((e: unknown) => { init = undefined; throw e; })) };
}

type Vars = { input: any; leaves?: Leaf[]; reserved?: number; redeem?: { key: string; h: string } };
export const REDEEM_NOTE = "If your connection drops after paying, resend the IDENTICAL payment header (same signed payload) to the same endpoint within 1 hour: you get the same stored response with 200 and are not charged again. Any other reuse of a payment returns 409.";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const PAID = new Set(Object.keys(PRICES));
const day = () => new Date().toISOString().slice(0, 10);
const minute = () => Math.floor(Date.now() / 60000);
const neuronKey = () => `neurons:${day()}`;
const neuronBudget = (env: Env) => Number(env.NEURON_BUDGET ?? DEFAULT_NEURON_BUDGET);
const secondsToUtcMidnight = () => { const n = new Date(); return Math.ceil((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime()) / 1000); };
const isStr = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && [...v].length <= max;
const enumOk = (v: unknown, opts: readonly string[]) => v === undefined || opts.includes(v as string);
/** Per-route input validation (runs before any 402). */
export function validateInput(path: string, b: any): { status: number; error: string; detail: string } | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { status: 400, error: "invalid_input", detail: "JSON object body required" };
  if (path === "/localize-ar-json") return b.json && typeof b.json === "object" && !Array.isArray(b.json) ? null : { status: 400, error: "invalid_input", detail: "json (object) required" };
  if (typeof b.text !== "string" || !b.text.trim()) return { status: 400, error: "invalid_input", detail: "text (string) required" };
  if (!isStr(b.text, MAX_INPUT_CHARS)) return { status: 413, error: "payload_too_large", detail: `text max ${MAX_INPUT_CHARS} chars` };
  if (path === "/translate-ar") {
    if (!enumOk(b.direction, ["auto", "ar-en", "en-ar"])) return { status: 400, error: "invalid_input", detail: "direction" };
    if (!enumOk(b.glossary, Object.keys(GLOSSARIES))) return { status: 400, error: "invalid_input", detail: "glossary (supported: web3)" };
  }
  if (path === "/summarize-ar" && !enumOk(b.length, ["short", "medium", "long"])) return { status: 400, error: "invalid_input", detail: "length" };
  if (path === "/dialect-to-msa") {
    if (!enumOk(b.direction, ["dialect-msa", "msa-dialect"])) return { status: 400, error: "invalid_input", detail: "direction (dialect-msa | msa-dialect)" };
    if (!enumOk(b.dialect, Object.keys(DIALECTS))) return { status: 400, error: "invalid_input", detail: "dialect (saudi | gulf)" };
  }
  return null;
}

export const TAGS = ["arabic", "gulf", "saudi", "web3", "localization"];
export const SERVICE_NAME = "x402 Arabic API";
const COMMON = "Arabic-native, Gulf-dialect aware; keeps 0x addresses, URLs, numbers and code verbatim (regex post-check, retried once; address/URL/number loss is never charged).";
export const ROUTE_DOCS = {
  "/translate-ar": { input: translateInput, output: translateOutput, ex: examples.translate,
    description: `Arabic<->English translation (auto-detects direction; understands Saudi/Gulf dialect input). Optional glossary=web3 enforces a fixed Arabic Web3 terminology list. ${COMMON}` },
  "/summarize-ar": { input: summarizeInput, output: summarizeOutput, ex: examples.summarize,
    description: `Faithful Modern Standard Arabic summary (short/medium/long) of Arabic or English text. ${COMMON}` },
  "/dialect-to-msa": { input: dialectInput, output: dialectOutput, ex: examples.dialect,
    description: `Converts Saudi/Gulf dialect Arabic to Modern Standard Arabic (فصحى), or MSA to natural Saudi/Gulf dialect (direction param). ${COMMON}` },
  "/localize-ar-json": { input: localizeInput, output: localizeOutput, ex: examples.localize,
    description: `Localizes an i18n JSON object to Arabic: keys unchanged; placeholders ({name}, {{count}}, %s, %d, ICU plural/select, HTML tags) kept verbatim and validated per string, retried once, else the source string is returned for that key. Max 200 strings / 8000 chars. ${COMMON}` },
} as const;

export function buildRoutes(env: Env) {
  const net = resolveNetwork(env);
  const payTo = env.PAY_TO!; // fixed server-side from a Worker var — never from the request
  const price = (amount: string) => ({ amount, asset: net.usdc, extra: { name: net.eip712.name, version: net.eip712.version } });
  const accepts = (amount: string) => ({ scheme: "exact", network: net.caip2, payTo, price: price(amount), maxTimeoutSeconds: 120 });
  const r: any = {};
  for (const [path, d] of Object.entries(ROUTE_DOCS)) {
    r[`POST ${path}`] = {
      accepts: accepts((PRICES as any)[path]),
      description: d.description + " " + REDEEM_NOTE,
      mimeType: "application/json", serviceName: SERVICE_NAME, tags: TAGS,
      extensions: { ...declareDiscoveryExtension({ method: "POST", bodyType: "json", input: d.ex.req, inputSchema: d.input, output: { example: d.ex.res, schema: d.output } } as any) },
    };
  }
  return r;
}

export function buildAllRoutes(env: Env) {
  const r = buildRoutes(env);
  for (const k of Object.keys(r)) r[k.replace("POST ", "GET ")] = { ...r[k] };
  return r;
}

/** Decode the x402 payment header (v2 PAYMENT-SIGNATURE or v1 X-PAYMENT) to get payer + EIP-3009 nonce. */
export function readPaymentIdentity(header: string): { from: string; nonce: string; scheme: string } | null {
  try {
    const j = JSON.parse(atob(header));
    const a = j?.payload?.authorization ?? j?.payload?.permit2Authorization;
    const from = String(a?.from ?? "").toLowerCase();
    const nonce = String(a?.nonce ?? "").toLowerCase();
    if (!ADDR.test(from) || !/^0x[0-9a-f]{1,64}$/.test(nonce)) return null;
    const scheme = String(j?.accepted?.scheme ?? j?.scheme ?? "");
    return { from, nonce, scheme };
  } catch { return null; }
}

export const LOCALIZE_MAX_FALLBACK = 0.2;
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0f766e"/><text x="16" y="23" font-size="20" text-anchor="middle" fill="#fff" font-family="sans-serif">ع</text></svg>`;
export const settleStop = (env: Env) => { const v = Number(env.SETTLE_STOP ?? DEFAULT_SETTLE_STOP); return Number.isFinite(v) && v >= 0 ? v : DEFAULT_SETTLE_STOP; };

export function createApp(deps: Deps) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.get("/", (c) => c.html(docsHtml(c.env)));
  app.get("/health", async (c) => {
    const err = paymentConfigError(c.env); const name = facilitatorName(c.env.FACILITATOR);
    let settled: number | null = null;
    try { settled = await deps.guard(c.env).count(settleKey(name)); } catch { /* stats are best-effort */ }
    return c.json({ ok: true, network: resolveNetwork(c.env).caip2, payToConfigured: ADDR.test(c.env.PAY_TO ?? ""), paidRoutes: err ? `disabled: ${err}` : "enabled",
      facilitator: name, scheme: "exact", settlements: { [name]: settled }, ...(name === "payai" ? { payaiWarnAt: PAYAI_WARN_AT } : {}),
      settleStop: { at: settleStop(c.env) || null, stopped: settleStop(c.env) > 0 && (settled === null || settled >= settleStop(c.env)) } });
  });
  // Tiny inline SVG favicon: free, unprotected, never touches the guard or payments.
  app.get("/favicon.ico", (c) => c.body(FAVICON, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }));
  const oaCache = new Map<string, string>();
  app.get("/openapi.json", (c) => {
    const origin = new URL(c.req.url).origin; const k = `${origin}|${c.env.X402_NETWORK}`;
    let doc = oaCache.get(k); if (!doc) { doc = JSON.stringify(buildOpenApi(c.env, origin)); oaCache.set(k, doc); }
    return c.body(doc, 200, { "content-type": "application/json" });
  });
  app.get("/.well-known/x402", (c) => {
    const net = resolveNetwork(c.env); const origin = new URL(c.req.url).origin;
    return c.json({
      note: "Informational manifest (not a normative x402 spec file). Authoritative terms are in each endpoint's 402 PAYMENT-REQUIRED response.",
      version: 1, x402Version: 2, openapi: `${origin}/openapi.json`,
      serviceName: SERVICE_NAME, tags: TAGS,
      resources: Object.keys(PRICES).map((p) => `${origin}${p}`),
      pricing: Object.entries(PRICES).map(([p, amount]) => ({ resource: `${origin}${p}`, method: "POST", scheme: "exact", network: net.caip2, asset: net.usdc, amount, decimals: 6, usd: (Number(amount) / 1e6).toFixed(2), payTo: ADDR.test(c.env.PAY_TO ?? "") ? c.env.PAY_TO : null, description: (ROUTE_DOCS as any)[p].description })),
      free: [{ resource: `${origin}/try/translate-ar`, method: "POST", description: `Free trial translation: <= ${TRIAL_MAX_CHARS} chars, ${TRIAL_PER_IP_PER_DAY}/IP/day, global daily cap; 429 above limits.` }],
    });
  });

  // ---- pre-payment guards for paid routes (run BEFORE any 402/verify/model call) ----
  app.use("*", async (c, next) => {
    if (!PAID.has(c.req.path)) return next();
    const cfgErr = paymentConfigError(c.env);
    if (cfgErr) return c.json({ error: "payments_not_configured", detail: cfgErr }, 503);
    // Settlement stop (risk manager): at SETTLE_STOP cumulative settlements, refuse BEFORE any 402. Fails closed.
    const stop = settleStop(c.env);
    if (stop > 0) {
      let n: number; try { n = await deps.guard(c.env).count(settleKey(facilitatorName(c.env.FACILITATOR))); } catch { n = Infinity; }
      if (n >= stop) return c.json({ error: "settlement_stop", detail: `settlement limit reached (${stop}); paid routes paused by the operator` }, 503, { "retry-after": "86400" });
    }
    // GET/HEAD probes (directories/indexers) get the 402 challenge; the GET handler is always 405 so nothing settles.
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      const ip = c.req.header("cf-connecting-ip") ?? "unknown";
      if (!(await deps.guard(c.env).take(`ip:${ip}:${minute()}`, IP_LIMIT_PER_MIN, 120))) return c.json({ error: "rate_limited_ip" }, 429);
      return next();
    }
    if (c.req.method !== "POST") return c.json({ error: "method_not_allowed" }, 405);

    const maxBytes = c.req.path === "/localize-ar-json" ? LOCALIZE_MAX_BODY_BYTES : MAX_BODY_BYTES;
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > maxBytes) return c.json({ error: "payload_too_large", detail: `max ${maxBytes} bytes` }, 413);
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > maxBytes) return c.json({ error: "payload_too_large", detail: `max ${maxBytes} bytes` }, 413);
    let body: any;
    try { body = JSON.parse(raw); } catch { return c.json({ error: "invalid_json" }, 400); }
    // Input validation BEFORE any 402, so nobody is asked to pay for a request we would reject.
    const bad = validateInput(c.req.path, body);
    if (bad) return c.json({ error: bad.error, detail: bad.detail }, bad.status as any);
    if (c.req.path === "/localize-ar-json") {
      const f = flatten(body.json);
      if ("error" in f) return c.json({ error: f.error.startsWith("max") ? "payload_too_large" : "invalid_input", detail: f.error }, f.error.startsWith("max") ? 413 : 400);
      c.set("leaves", f.leaves);
    }
    c.set("input", body);

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const ph = c.req.header("payment-signature") ?? c.req.header("x-payment");
    const id = ph ? readPaymentIdentity(ph) : null;
    if (ph && !id) return c.json({ error: "malformed_payment" }, 400);
    if (id && id.scheme !== "exact") return c.json({ error: "unsupported_scheme", detail: "only x402 'exact' is accepted" }, 400);
    const nw = resolveNetwork(c.env); const net = nw.caip2;
    let rk: { key: string; h: string } | undefined;
    if (ph && id) {
      // Hand validation of every payment field (no JSON-schema library on the payment path).
      let decoded: any; try { decoded = JSON.parse(atob(ph)); } catch { return c.json({ error: "malformed_payment" }, 400); }
      const bad = validatePayment(decoded, { network: net, asset: nw.usdc, payTo: c.env.PAY_TO!, amount: (PRICES as any)[c.req.path] });
      if (bad) return c.json({ error: "invalid_payment", detail: bad }, 400);
      rk = { key: await redeemKey(net, nw.usdc, id.from, id.nonce), h: await sha256Hex(ph) };
      c.set("redeem", rk);
    }
    // One Durable Object round-trip for IP rate, cap peek, payer rate and replay claim.
    const worst = WORST_NEURONS[c.req.path];
    const r = await deps.guard(c.env).admit({
      ip: { key: `ip:${ip}:${minute()}`, limit: IP_LIMIT_PER_MIN },
      cap: { key: `cap:${day()}`, limit: Number(c.env.DAILY_CAP ?? DEFAULT_DAILY_CAP), take: !!id },
      budget: { key: neuronKey(), n: worst, limit: neuronBudget(c.env) },
      ...(id ? { payer: { key: `payer:${id.from}:${minute()}`, limit: PAYER_LIMIT_PER_MIN }, nonce: { key: `nonce:${net}:${id.from}:${id.nonce}`, ttlSec: 30 * 86400 } } : {}),
    });
    if (r === "ip") return c.json({ error: "rate_limited_ip" }, 429);
    if (r === "cap" || r === "budget") return c.json({ error: "daily_capacity_reached", detail: "try again after 00:00 UTC" }, 503);
    if (id) c.set("reserved", worst);
    if (r === "payer") return c.json({ error: "rate_limited_payer" }, 429);
    if (r === "replay") return redeem(c, id!, rk!);
    return next();
  });

  // ---- x402 ordering (enforced by @x402/hono): verify -> handler generates response -> settle -> return.
  // Handler status >= 400 (incl. our 5xx on model failure/empty) => settlement cancelled, buyer not charged.
  // Settle failure => 402 without the generated body.
  app.use("*", async (c, next) => {
    if (!PAID.has(c.req.path)) return next();
    let p: Payment;
    try { p = deps.payment(c.env); await p.ready(); } catch { return c.json({ error: "facilitator_unavailable" }, 503); }
    const ph = c.req.header("payment-signature") ?? c.req.header("x-payment");
    const nonce = ph ? readPaymentIdentity(ph)?.nonce ?? "" : "";
    let res: Response | undefined;
    try { res = await p.mw(c, next); } catch { p.fac.unavailable.add(nonce || "-"); }
    // verify/settle/receipt dependency unavailable or erroring => 503 with NO paid content (fresh response).
    if (p.fac.unavailable.delete(nonce || "-")) {
      c.res = undefined; // drop the generated/402 response entirely (Hono's setter would otherwise merge old headers)
      c.res = new Response(JSON.stringify({ error: "facilitator_unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
      return c.res;
    }
    return res ?? c.res;
  });

  /** Same payment seen again: serve the stored body once proven settled on-chain; otherwise strict 409. */
  async function redeem(c: Context<{ Bindings: Env; Variables: Vars }>, id: { from: string; nonce: string }, rk: { key: string; h: string }) {
    const replay = () => c.json({ error: "payment_replayed" }, 409);
    let stored: { h: string; path: string; body: string } | null = null;
    try { stored = await c.env.REDEEM!.get(rk.key, "json"); } catch { return c.json({ error: "redeem_unavailable" }, 503); }
    if (!stored || stored.h !== rk.h || stored.path !== c.req.path) return replay();
    let used: boolean | null;
    try { used = await deps.payment(c.env).fac.authUsed(id.from, id.nonce); } catch { used = null; }
    if (used === null) return c.json({ error: "redeem_unavailable", detail: "chain RPC unavailable, retry" }, 503);
    if (!used) return replay(); // never settled -> nothing was paid for
    return c.body(stored.body, 200, { "content-type": "application/json", "x-x402-redeemed": "true" });
  }

  /** Build the final body, persist it for redeem BEFORE settle (KV failure => 503 => middleware does not settle). */
  async function paidJson(c: Context<{ Bindings: Env; Variables: Vars }>, obj: unknown) {
    const body = JSON.stringify(obj); const rk = c.get("redeem");
    if (rk) {
      try { await c.env.REDEEM!.put(rk.key, JSON.stringify({ h: rk.h, path: c.req.path, body }), { expirationTtl: REDEEM_TTL_SEC }); }
      catch { return c.json({ error: "redeem_store_unavailable" }, 503); }
    }
    return c.body(body, 200, { "content-type": "application/json" });
  }

  /** Return the unused part of this request's neuron reservation (actual usage from the model's reported tokens). */
  async function refund(c: Context<{ Bindings: Env; Variables: Vars }>, m: Meter, reserved = c.get("reserved") ?? 0) {
    const back = Math.floor(reserved - Math.ceil(m.used));
    if (back > 0) { try { await deps.guard(c.env).addN(neuronKey(), -back, 0, 2 * 86400); } catch { /* best effort: keeps the conservative reservation */ } }
  }
  /** Run a generator under the meter; model failure/empty output/address loss => 5xx => middleware does not settle. */
  async function gen<T extends { text: string; checks: any }>(c: Context<{ Bindings: Env; Variables: Vars }>, m: Meter, f: () => Promise<T>) {
    let r: T;
    try { r = await f(); } catch { await refund(c, m); return { err: c.json({ error: "model_error" }, 502) }; }
    await refund(c, m);
    if (!r.text?.trim()) return { err: c.json({ error: "model_empty_output" }, 502) };
    if (hardFail(r.checks.verbatim)) return { err: c.json({ error: "verbatim_check_failed", detail: "the model altered a 0x address, URL or number twice; not charged", checks: r.checks }, 502) };
    return { r };
  }

  app.post("/translate-ar", async (c) => {
    const { text, direction = "auto", glossary } = c.get("input");
    const dir = direction === "auto" ? detectDirection(text) : direction;
    const m = new Meter();
    const g = await gen(c, m, () => translate(c.env.AI, text, dir, m, { glossary }));
    if (g.err) return g.err;
    return paidJson(c, { translation: g.r!.text, direction: dir, model: MODEL, checks: g.r!.checks });
  });

  app.post("/summarize-ar", async (c) => {
    const { text, length = "medium" } = c.get("input");
    const m = new Meter();
    const g = await gen(c, m, () => summarize(c.env.AI, text, length, m));
    if (g.err) return g.err;
    return paidJson(c, { summary: g.r!.text, length, model: MODEL, checks: g.r!.checks });
  });

  app.post("/dialect-to-msa", async (c) => {
    const { text, direction = "dialect-msa", dialect = "saudi" } = c.get("input");
    const m = new Meter();
    const g = await gen(c, m, () => dialectConvert(c.env.AI, text, direction, dialect, m));
    if (g.err) return g.err;
    return paidJson(c, { text: g.r!.text, direction, dialect, model: MODEL, checks: g.r!.checks });
  });

  app.post("/localize-ar-json", async (c) => {
    const { json } = c.get("input"); const leaves = c.get("leaves")!;
    const m = new Meter();
    let r: Awaited<ReturnType<typeof localize>>;
    try { r = await localize(c.env.AI, json, leaves, m); } catch { await refund(c, m); return c.json({ error: "model_error" }, 502); }
    await refund(c, m);
    // More than 20% of strings fell back to the source => 502 => not charged.
    const ratio = r.total ? r.fallbackKeys.length / r.total : 1;
    if (r.localized === 0 || ratio > LOCALIZE_MAX_FALLBACK)
      return c.json({ error: r.modelErrors && r.localized === 0 ? "model_error" : "localization_failed",
        detail: `${r.fallbackKeys.length}/${r.total} strings failed validation (max ${LOCALIZE_MAX_FALLBACK * 100}%); not charged`, checks: { fallbackKeys: r.fallbackKeys } }, 502);
    return paidJson(c, { json: r.json, localized: r.localized, total: r.total, model: MODEL,
      checks: { fallbackKeys: r.fallbackKeys, fallbackRatio: Math.round(ratio * 1000) / 1000, retried: r.retried } });
  });

  // ---- Free trial (no payment): short translations only, per-IP/day + global/day + shared neuron budget (Guard DO). ----
  app.all("/try/translate-ar", async (c) => {
    if (c.req.method !== "POST") return c.json({ error: "method_not_allowed", detail: "use POST" }, 405);
    const trialCap = Number(c.env.TRIAL_DAILY_CAP ?? DEFAULT_TRIAL_DAILY_CAP);
    if (!(trialCap > 0)) return c.json({ error: "trial_disabled" }, 404);
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > 4096) return c.json({ error: "payload_too_large", detail: "max 4096 bytes" }, 413);
    let body: any; try { body = JSON.parse(raw); } catch { return c.json({ error: "invalid_json" }, 400); }
    const { text, direction = "auto" } = body ?? {};
    if (typeof text !== "string" || !text.trim()) return c.json({ error: "invalid_input", detail: "text (string) required" }, 400);
    if ([...text].length > TRIAL_MAX_CHARS) return c.json({ error: "payload_too_large", detail: `trial text max ${TRIAL_MAX_CHARS} chars; use paid POST /translate-ar for up to ${MAX_INPUT_CHARS}` }, 413);
    if (!["auto", "ar-en", "en-ar"].includes(direction)) return c.json({ error: "invalid_input", detail: "direction" }, 400);
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const r = await deps.guard(c.env).trial({
      ip: { key: `trial:ip:${ip}:${day()}`, limit: TRIAL_PER_IP_PER_DAY },
      cap: { key: `trial:cap:${day()}`, limit: trialCap },
      budget: { key: neuronKey(), n: TRIAL_WORST_NEURONS, limit: neuronBudget(c.env) },
    });
    if (r !== "ok") return c.json({ error: r === "ip" ? "trial_limit_ip" : "trial_daily_cap", detail: r === "ip" ? `${TRIAL_PER_IP_PER_DAY} free calls per IP per UTC day` : "free trial capacity for today is used up", paid: "POST /translate-ar" }, 429, { "retry-after": String(secondsToUtcMidnight()) });
    c.set("reserved", TRIAL_WORST_NEURONS);
    const dir = direction === "auto" ? detectDirection(text) : direction;
    const m = new Meter();
    let out: Awaited<ReturnType<typeof translate>>;
    try { out = await translate(c.env.AI, text, dir, m, { maxTokens: TRIAL_MAX_TOKENS, retry: false }); } catch { await refund(c, m); return c.json({ error: "model_error" }, 502); }
    await refund(c, m);
    if (!out.text?.trim()) return c.json({ error: "model_empty_output" }, 502);
    return c.json({ translation: out.text, direction: dir, model: MODEL, trial: true, checks: out.checks, paid: "POST /translate-ar (x402, 0.01 USDC) for up to 4000 chars and glossary=web3" });
  });

  for (const p of PAID) app.get(p, (c) => c.json({ error: "method_not_allowed", detail: "use POST" }, 405));
  app.post("/arabic-ocr", (c) => c.json({ error: "not_available", detail: "No free Workers AI vision model reliably reads Arabic script; endpoint intentionally not offered." }, 404));
  return app;
}

/** Facilitator selection: exactly ONE keyless facilitator per network. No fallback (risk-manager rule). */
export function defaultFacilitator(env: Env, guard: () => GuardApi): SafeFacilitator {
  const net = resolveNetwork(env);
  const f = env.FACILITATOR;
  if (f === "payai") {
    if (net.caip2 !== "eip155:8453" && net.caip2 !== "eip155:84532") throw new Error("unsupported network");
  } else if (!(f === "x402org-testnet" && net.caip2 === "eip155:84532")) throw new Error("unsupported facilitator");
  return new SafeFacilitator({
    name: facilitatorName(f), client: new HTTPFacilitatorClient({ url: FACILITATOR_URLS[f as keyof typeof FACILITATOR_URLS] }),
    guard, rpcs: [...net.rpcs], asset: net.usdc, payTo: env.PAY_TO!, log: (m) => console.warn(m),
  });
}

function docsHtml(env: Env) {
  const net = resolveNetwork(env);
  return `<!doctype html><meta charset="utf-8"><title>x402 Arabic API</title><body style="font-family:sans-serif;max-width:720px;margin:2em auto">
<h1>x402 Arabic API</h1><p>Pay-per-request Arabic translation & summarization for AI agents. Payment: x402 <code>exact</code>, USDC on <code>${net.caip2}</code> (asset <code>${net.usdc}</code>).</p>
<p>Arabic-native, Gulf-dialect aware; keeps 0x addresses, URLs and numbers verbatim.</p>
<ul><li><b>POST /translate-ar</b> — 0.01 USDC. Body <code>{"text":"…","direction":"auto|ar-en|en-ar","glossary":"web3"?}</code></li>
<li><b>POST /summarize-ar</b> — 0.02 USDC. Body <code>{"text":"…","length":"short|medium|long"}</code></li>
<li><b>POST /dialect-to-msa</b> — 0.01 USDC. Body <code>{"text":"…","direction":"dialect-msa|msa-dialect","dialect":"saudi|gulf"}</code></li>
<li><b>POST /localize-ar-json</b> — 0.02 USDC. Body <code>{"json":{…i18n…}}</code> (≤200 strings, ≤8000 chars)</li>
<li><b>POST /try/translate-ar</b> — free trial, ≤${TRIAL_MAX_CHARS} chars, ${TRIAL_PER_IP_PER_DAY}/IP/day.</li></ul>
<p>Unpaid requests get <code>402</code> with a <code>PAYMENT-REQUIRED</code> header. Max ${MAX_INPUT_CHARS} chars. Free: <a href="/openapi.json">/openapi.json</a>, <a href="/.well-known/x402">/.well-known/x402</a>, <a href="/health">/health</a>.</p></body>`;
}
