import web3 from "./glossary/web3.json";

/** en = English match forms; ar = accepted Arabic forms (ar[0] is the one the prompt asks for). */
export type Term = { en: string[]; ar: string[] };
export const GLOSSARIES = { web3: web3.terms as Term[] } as const;
export type GlossaryName = keyof typeof GLOSSARIES;
export const GLOSSARY_STATUS = web3._status; // "reviewed by Nouf 2026-10-31"

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isLatin = (s: string) => !/[\u0600-\u06FF]/.test(s);

/**
 * Arabic normalization applied to BOTH the glossary forms and the model text before matching:
 * strip tashkeel/shadda/superscript alef and tatweel, unify alef-hamza forms, and drop a leading
 * article ال (also after a one-letter proclitic: وال بال فال كال, and لل) from every word.
 */
export function normalizeAr(s: string): string {
  return s
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/(^|[^\p{L}])([وفبك]?ال|لل)(?=\p{L}{2})/gu, "$1");
}
export const stripDiacritics = (s: string) => s.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "");

/** Regex for one accepted form, on normalized text: word start (optionally after و ب ل ف ك), never after "لا"
 *  (so مركزية does not match inside لامركزية / لا مركزية), final ة also matching ت/ه (محفظتك), suffixes allowed. */
function arForm(form: string): RegExp {
  if (isLatin(form)) return new RegExp(`(?<![A-Za-z0-9])${esc(form)}(?![A-Za-z0-9])`, "i");
  const body = normalizeAr(form).split(/\s+/).map((w) => esc(w).replace(/ة$/, "[ةته]")).join("\\s+");
  return new RegExp(`(?<!لا\\s?)(?<![\\p{L}])[وبلفك]?${body}`, "u");
}
const enForm = (f: string) => new RegExp(`(?<![A-Za-z0-9])${esc(f)}(?![A-Za-z0-9])`, "gi");

/** All (form, term) pairs for a side, longest first, so "gas fee" is consumed before "gas", لامركزية before مركزية. */
const pairs = (g: Term[], side: "en" | "ar") =>
  g.flatMap((t) => t[side].map((f) => ({ f, t }))).sort((a, b) => b.f.length - a.f.length);

/** Terms that occur in the source text (for the given direction). Matched spans are consumed (longest first). */
export function matchTerms(name: GlossaryName, text: string, dir: "en-ar" | "ar-en"): Term[] {
  const g = GLOSSARIES[name]; const hit = new Set<Term>();
  if (dir === "ar-en") {
    let rest = normalizeAr(text);
    for (const { f, t } of pairs(g, "ar")) {
      const re = new RegExp(arForm(f).source, arForm(f).flags + "g");
      if (re.test(rest)) { hit.add(t); rest = rest.replace(re, " "); }
    }
    return [...hit];
  }
  let rest = text;
  for (const { f, t } of pairs(g, "en")) { const re = enForm(f); if (re.test(rest)) { hit.add(t); rest = rest.replace(enForm(f), " "); } }
  return [...hit];
}
export function glossaryPrompt(terms: Term[], dir: "en-ar" | "ar-en"): string {
  if (!terms.length) return "";
  const lines = terms.map((t) => (dir === "en-ar" ? `${t.en[0]} => ${t.ar[0]}` : `${t.ar[0]} => ${t.en[0]}`)).join("\n");
  return `\nMANDATORY TERMINOLOGY (use exactly these renderings for these terms; add the definite article/prefix or plural as grammar requires):\n${lines}\n`;
}
/** Terms whose rendering is missing from the output (any accepted form counts). */
export function missingTerms(terms: Term[], out: string, dir: "en-ar" | "ar-en"): Term[] {
  if (dir === "en-ar") { const n = normalizeAr(out); return terms.filter((t) => !t.ar.some((f) => arForm(f).test(n))); }
  return terms.filter((t) => !t.en.some((f) => new RegExp(`(?<![A-Za-z0-9])${esc(f)}`, "i").test(out)));
}
