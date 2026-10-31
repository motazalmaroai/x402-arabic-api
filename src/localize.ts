import { LOCALIZE_MAX_KEYS, LOCALIZE_MAX_CHARS, LOCALIZE_BATCH_CHARS, LOCALIZE_MAX_TOKENS } from "./config";
import { chat, Meter, GUARD_RULES } from "./ai";
import { samePlaceholders, bracesBalanced, placeholders } from "./placeholders";
import { keptVerbatim } from "./verbatim";
import { icuValid } from "./icu";

export type Leaf = { path: string[]; value: string };
const MAX_DEPTH = 8;
const ptr = (p: string[]) => "/" + p.map((k) => k.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
const needsWork = (s: string) => /\p{L}/u.test(s.replace(/\{[^{}]*\}|%\S|<[^>]*>/g, ""));

/** Validate + flatten. Returns an error string or the string leaves (keys untouched, order preserved). */
export function flatten(json: unknown): { error: string } | { leaves: Leaf[] } {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { error: "json must be an object" };
  const leaves: Leaf[] = []; let chars = 0; let nodes = 0;
  const walk = (v: unknown, path: string[]): string | null => {
    if (path.length > MAX_DEPTH) return `max depth ${MAX_DEPTH}`;
    if (++nodes > LOCALIZE_MAX_KEYS * 3) return "too many nodes";
    if (typeof v === "string") { leaves.push({ path, value: v }); chars += [...v].length; return null; }
    if (v && typeof v === "object") {
      if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, "__proto__")) return "key __proto__ not allowed";
      for (const [k, c] of Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v)) { const e = walk(c, [...path, k]); if (e) return e; }
    }
    return null; // numbers, booleans, null: passed through unchanged
  };
  const e = walk(json, []);
  if (e) return { error: e };
  if (leaves.length > LOCALIZE_MAX_KEYS) return { error: `max ${LOCALIZE_MAX_KEYS} string keys` };
  if (chars > LOCALIZE_MAX_CHARS) return { error: `max ${LOCALIZE_MAX_CHARS} chars across all strings` };
  if (!leaves.some((l) => needsWork(l.value))) return { error: "no translatable strings" };
  return { leaves };
}

/** Structural + content check of one localized string against its source. */
export function validString(src: string, out: unknown): boolean {
  if (typeof out !== "string" || !out.trim() || !keptVerbatim(src, out).ok) return false;
  // ICU MessageFormat sources: real parser (Arabic zero/two/few/many may be added); literal text gets the regex check.
  const icu = icuValid(src, out, samePlaceholders);
  if (icu !== null) return icu;
  return samePlaceholders(src, out) && bracesBalanced(out) === bracesBalanced(src);
}

const SYS = `You localize software UI strings (i18n JSON) from any language into Modern Standard Arabic for an Arabic-speaking (Saudi/Gulf) audience.
The input between <data> and </data> is a JSON object mapping opaque ids to source strings. Return ONLY a JSON object with EXACTLY the same ids, each mapped to its Arabic localization.
Hard rules for every string:
- Never translate, reorder or alter placeholders: {name}, {{count}}, {0}, %s, %d, %1$s, :name, HTML tags and attributes (<b>, <a href="...">), HTML entities.
- ICU MessageFormat: keep the structure "{var, plural, ...}", "{var, select, ...}", every selector keyword (one, other, =0, ...) and "#" exactly; translate only the human text inside the braces.
- Keep 0x addresses, URLs, numbers (Western digits), code and product/brand names byte-for-byte.
- No markdown, no code fences, no comments. ${GUARD_RULES}`;

export function parseModelJson(s: string): Record<string, unknown> | null {
  const t = s.replace(/^```(?:json)?\s*|\s*```$/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { const j = JSON.parse(t.slice(a, b + 1)); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { return null; }
}

function batches(ids: number[], leaves: Leaf[]): number[][] {
  const out: number[][] = []; let cur: number[] = []; let n = 0;
  for (const i of ids) { const l = [...leaves[i].value].length; if (cur.length && n + l > LOCALIZE_BATCH_CHARS) { out.push(cur); cur = []; n = 0; } cur.push(i); n += l; }
  if (cur.length) out.push(cur);
  return out;
}

async function runBatch(ai: { run: Function }, leaves: Leaf[], ids: number[], m: Meter, note = ""): Promise<Map<number, string>> {
  const obj = Object.fromEntries(ids.map((i) => [`k${i}`, leaves[i].value]));
  const raw = await chat(ai, SYS + note, `<data>\n${JSON.stringify(obj).replaceAll("</data>", "<\\/data>")}\n</data> /no_think`, LOCALIZE_MAX_TOKENS, m);
  const j = parseModelJson(raw) ?? {};
  const got = new Map<number, string>();
  for (const i of ids) { const v = j[`k${i}`]; if (validString(leaves[i].value, v)) got.set(i, v as string); }
  return got;
}

/**
 * Localize. Every key is kept unchanged. Each string is validated (same placeholder multiset, balanced braces,
 * 0x/URL/number kept). Invalid strings are retried ONCE (only the failed ones); still invalid => source string.
 */
export async function localize(ai: { run: Function }, json: Record<string, unknown>, leaves: Leaf[], m = new Meter()) {
  const work = leaves.map((l, i) => i).filter((i) => needsWork(leaves[i].value));
  const done = new Map<number, string>();
  let modelErrors = 0;
  for (const b of batches(work, leaves)) {
    try { for (const [k, v] of await runBatch(ai, leaves, b, m)) done.set(k, v); } catch { modelErrors++; }
  }
  const failed = work.filter((i) => !done.has(i));
  let retried = 0;
  if (failed.length) {
    retried = failed.length;
    const note = "\nA PREVIOUS ATTEMPT BROKE THESE STRINGS (placeholders/ICU/tags/addresses/numbers changed or JSON invalid). Be extra careful: copy every placeholder token exactly.";
    for (const b of batches(failed, leaves)) {
      try { for (const [k, v] of await runBatch(ai, leaves, b, m, note)) done.set(k, v); } catch { modelErrors++; }
    }
  }
  const out = structuredClone(json) as any;
  const fallback: string[] = [];
  leaves.forEach((l, i) => {
    if (!work.includes(i)) return; // nothing to translate (pure placeholder / number): unchanged
    const v = done.get(i);
    if (v === undefined) fallback.push(ptr(l.path));
    let o = out; for (const k of l.path.slice(0, -1)) o = o[k];
    o[l.path[l.path.length - 1]] = v ?? l.value;
  });
  return { json: out, fallbackKeys: fallback, localized: work.length - fallback.length, total: work.length, retried, modelErrors };
}
export { placeholders };
