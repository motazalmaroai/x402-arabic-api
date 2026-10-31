import { Hono, type Context } from "hono";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { SafeFacilitator, settleKey, PAYAI_WARN_AT } from "./settlement";
import {
  type Env, PRICES, MAX_BODY_BYTES, MAX_INPUT_CHARS, DEFAULT_DAILY_CAP, IP_LIMIT_PER_MIN, PAYER_LIMIT_PER_MIN, MODEL, resolveNetwork, paymentConfigError, FACILITATOR_URLS, facilitatorName,
} from "./config";
import type { GuardApi } from "./guard";
import { translateInput, translateOutput, summarizeInput, summarizeOutput, examples } from "./schemas";
import { buildOpenApi } from "./openapi";
import { validatePayment, redeemKey, sha256Hex, REDEEM_TTL_SEC } from "./redeem";
import { detectDirection, translate, summarize } from "./ai";

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

type Vars = { input: any; redeem?: { key: string; h: string } };
export const REDEEM_NOTE = "If your connection drops after paying, resend the IDENTICAL payment header (same signed payload) to the same endpoint within 1 hour: you get the same stored response with 200 and are not charged again. Any other reuse of a payment returns 409.";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const PAID = new Set(Object.keys(PRICES));
const day = () => new Date().toISOString().slice(0, 10);
const minute = () => Math.floor(Date.now() / 60000);

export function buildRoutes(env: Env) {
  const net = resolveNetwork(env);
  const payTo = env.PAY_TO!; // fixed server-side from a Worker var — never from the request
  const price = (amount: string) => ({ amount, asset: net.usdc, extra: { name: net.eip712.name, version: net.eip712.version } });
  const accepts = (amount: string) => ({ scheme: "exact", network: net.caip2, payTo, price: price(amount), maxTimeoutSeconds: 120 });
  return {
    "POST /translate-ar": {
      accepts: accepts(PRICES["/translate-ar"]),
      description: "Translate Arabic<->English (auto-detects direction). Use when: an agent needs accurate MSA Arabic<->English translation that preserves addresses, numbers and code verbatim. " + REDEEM_NOTE,
      mimeType: "application/json",
      extensions: { ...declareDiscoveryExtension({ method: "POST", bodyType: "json", input: examples.translate.req, inputSchema: translateInput, output: { example: examples.translate.res, schema: translateOutput } } as any) },
    },
    "POST /summarize-ar": {
      accepts: accepts(PRICES["/summarize-ar"]),
      description: "Summarize Arabic or English text into Modern Standard Arabic (short/medium/long). Use when: an agent needs an Arabic summary of a document or article. " + REDEEM_NOTE,
      mimeType: "application/json",
      extensions: { ...declareDiscoveryExtension({ method: "POST", bodyType: "json", input: examples.summarize.req, inputSchema: summarizeInput, output: { example: examples.summarize.res, schema: summarizeOutput } } as any) },
    },
  } as any;
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

export function createApp(deps: Deps) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.get("/", (c) => c.html(docsHtml(c.env)));
  app.get("/health", async (c) => {
    const err = paymentConfigError(c.env); const name = facilitatorName(c.env.FACILITATOR);
    let settled: number | null = null;
    try { settled = await deps.guard(c.env).count(settleKey(name)); } catch { /* stats are best-effort */ }
    return c.json({ ok: true, network: resolveNetwork(c.env).caip2, payToConfigured: ADDR.test(c.env.PAY_TO ?? ""), paidRoutes: err ? `disabled: ${err}` : "enabled",
      facilitator: name, scheme: "exact", settlements: { [name]: settled }, ...(name === "payai" ? { payaiWarnAt: PAYAI_WARN_AT } : {}) });
  });
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
      resources: Object.keys(PRICES).map((p) => `${origin}${p}`),
      pricing: Object.entries(PRICES).map(([p, amount]) => ({ resource: `${origin}${p}`, method: "POST", scheme: "exact", network: net.caip2, asset: net.usdc, amount, decimals: 6, payTo: ADDR.test(c.env.PAY_TO ?? "") ? c.env.PAY_TO : null })),
    });
  });

  // ---- pre-payment guards for paid routes (run BEFORE any 402/verify/model call) ----
  app.use("*", async (c, next) => {
    if (!PAID.has(c.req.path)) return next();
    const cfgErr = paymentConfigError(c.env);
    if (cfgErr) return c.json({ error: "payments_not_configured", detail: cfgErr }, 503);
    // GET/HEAD probes (directories/indexers) get the 402 challenge; the GET handler is always 405 so nothing settles.
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      const ip = c.req.header("cf-connecting-ip") ?? "unknown";
      if (!(await deps.guard(c.env).take(`ip:${ip}:${minute()}`, IP_LIMIT_PER_MIN, 120))) return c.json({ error: "rate_limited_ip" }, 429);
      return next();
    }
    if (c.req.method !== "POST") return c.json({ error: "method_not_allowed" }, 405);

    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_BODY_BYTES) return c.json({ error: "payload_too_large", detail: `max ${MAX_BODY_BYTES} bytes` }, 413);
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return c.json({ error: "payload_too_large", detail: `max ${MAX_BODY_BYTES} bytes` }, 413);
    let body: any;
    try { body = JSON.parse(raw); } catch { return c.json({ error: "invalid_json" }, 400); }
    if (typeof body?.text !== "string" || !body.text.trim()) return c.json({ error: "invalid_input", detail: "text (string) required" }, 400);
    if ([...body.text].length > MAX_INPUT_CHARS) return c.json({ error: "payload_too_large", detail: `text max ${MAX_INPUT_CHARS} chars` }, 413);
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
    const r = await deps.guard(c.env).admit({
      ip: { key: `ip:${ip}:${minute()}`, limit: IP_LIMIT_PER_MIN },
      cap: { key: `cap:${day()}`, limit: Number(c.env.DAILY_CAP ?? DEFAULT_DAILY_CAP), take: !!id },
      ...(id ? { payer: { key: `payer:${id.from}:${minute()}`, limit: PAYER_LIMIT_PER_MIN }, nonce: { key: `nonce:${net}:${id.from}:${id.nonce}`, ttlSec: 30 * 86400 } } : {}),
    });
    if (r === "ip") return c.json({ error: "rate_limited_ip" }, 429);
    if (r === "cap") return c.json({ error: "daily_capacity_reached", detail: "try again after 00:00 UTC" }, 503);
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

  app.post("/translate-ar", async (c) => {
    const { text, direction = "auto" } = c.get("input");
    if (!["auto", "ar-en", "en-ar"].includes(direction)) return c.json({ error: "invalid_input", detail: "direction" }, 400);
    const dir = direction === "auto" ? detectDirection(text) : direction;
    let out: string;
    try { out = await translate(c.env.AI, text, dir); } catch { return c.json({ error: "model_error" }, 502); } // 5xx => no settle
    if (!out?.trim()) return c.json({ error: "model_empty_output" }, 502);           // 5xx => no settle
    return paidJson(c, { translation: out, direction: dir, model: MODEL });
  });

  app.post("/summarize-ar", async (c) => {
    const { text, length = "medium" } = c.get("input");
    if (!["short", "medium", "long"].includes(length)) return c.json({ error: "invalid_input", detail: "length" }, 400);
    let out: string;
    try { out = await summarize(c.env.AI, text, length); } catch { return c.json({ error: "model_error" }, 502); } // 5xx => no settle
    if (!out?.trim()) return c.json({ error: "model_empty_output" }, 502);           // 5xx => no settle
    return paidJson(c, { summary: out, length, model: MODEL });
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
<ul><li><b>POST /translate-ar</b> — 0.05 USDC. Body <code>{"text":"…","direction":"auto|ar-en|en-ar"}</code></li>
<li><b>POST /summarize-ar</b> — 0.07 USDC. Body <code>{"text":"…","length":"short|medium|long"}</code></li></ul>
<p>Unpaid requests get <code>402</code> with a <code>PAYMENT-REQUIRED</code> header. Max ${MAX_INPUT_CHARS} chars. Free: <a href="/openapi.json">/openapi.json</a>, <a href="/.well-known/x402">/.well-known/x402</a>, <a href="/health">/health</a>.</p></body>`;
}
