/**
 * Verbatim post-checks (regex compare between input and output).
 * - 0x addresses / hashes (0x + >=6 hex) and URLs: byte-identical (case included).
 * - Numbers: compared after normalizing Arabic-Indic/Persian digits and thousands separators ("١٬٠٠٠" == "1,000" == "1000").
 */
const HEX = /0x[0-9a-fA-F]{6,}/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>()\[\]{}،]+[^\s"'<>()\[\]{}،.,;:!?]/g;
const DIGITS: Record<string, string> = {};
"٠١٢٣٤٥٦٧٨٩".split("").forEach((d, i) => (DIGITS[d] = String(i)));
"۰۱۲۳۴۵۶۷۸۹".split("").forEach((d, i) => (DIGITS[d] = String(i)));

export const addresses = (s: string) => s.match(HEX) ?? [];
export const urls = (s: string) => s.match(URL_RE) ?? [];
export function nums(s: string): string[] {
  const t = s.replace(URL_RE, " ").replace(HEX, " ").replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d]).replace(/٫/g, ".").replace(/٬/g, ",");
  return (t.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => {
    // "1,000,000" -> "1000000"; keep a single decimal part ("3.5" / "3,5" -> "3.5")
    const parts = n.split(/[.,]/);
    if (parts.length > 1 && parts.slice(1).every((p) => p.length === 3) && /,/.test(n) && !/\./.test(n)) return parts.join("");
    return n.replace(/,(?=\d{3}\b)/g, "").replace(",", ".");
  });
}

/** Items of `need` (multiset) not present in `have`. */
export function missingItems(need: string[], have: string[]): string[] {
  const pool = new Map<string, number>(); for (const h of have) pool.set(h, (pool.get(h) ?? 0) + 1);
  const miss: string[] = [];
  for (const n of need) { const c = pool.get(n) ?? 0; if (c > 0) pool.set(n, c - 1); else miss.push(n); }
  return miss;
}
const uniq = (a: string[]) => [...new Set(a)];

export interface VerbatimReport { ok: boolean; addresses: string[]; urls: string[]; numbers: string[] }
/** Everything in the source must be kept in the output (translation / dialect conversion / localization). */
export function keptVerbatim(src: string, out: string): VerbatimReport {
  const a = uniq(missingItems(addresses(src), addresses(out)));
  const u = uniq(missingItems(urls(src), urls(out)));
  const n = uniq(missingItems(nums(src), nums(out)));
  return { ok: !a.length && !u.length && !n.length, addresses: a, urls: u, numbers: n };
}
/** Summaries may drop items but must not invent or alter any (every output item must exist in the source). */
export function noInvented(src: string, out: string): VerbatimReport {
  const a = uniq(addresses(out).filter((x) => !addresses(src).includes(x)));
  const u = uniq(urls(out).filter((x) => !urls(src).includes(x)));
  const sn = new Set(nums(src));
  const n = uniq(nums(out).filter((x) => !sn.has(x)));
  return { ok: !a.length && !u.length && !n.length, addresses: a, urls: u, numbers: n };
}
export const hardFail = (r: VerbatimReport) => r.addresses.length > 0 || r.urls.length > 0 || r.numbers.length > 0;
