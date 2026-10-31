import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";

const ARABIC_EXTRA = new Set(["zero", "two", "few", "many"]);
const isIcuSource = (s: string) => /\{\s*[A-Za-z_$][\w$.]*\s*,\s*(?:plural|select|selectordinal)\b/.test(s);

export function tryParse(s: string): MessageFormatElement[] | null {
  try { return parse(s, { ignoreTag: true, requiresOtherClause: true }); } catch { return null; }
}

/** Structural signature; literal text is collected separately (for the regex placeholder check). */
function sig(els: MessageFormatElement[], lit: string[], inPlural = false): string {
  const parts = els.flatMap((e): string[] => {
    switch (e.type) {
      case TYPE.literal: lit.push(e.value); return [];
      case TYPE.pound: return inPlural ? [] : ["#"];
      case TYPE.argument: return [`{${e.value}}`];
      case TYPE.number: case TYPE.date: case TYPE.time: return [`{${e.value},${e.type}}`];
      case TYPE.tag: return [`<${e.value}>${sig(e.children, lit, inPlural)}</>`];
      case TYPE.select: return [`{${e.value},select:${Object.keys(e.options).sort().map((k) => `${k}=${sig(e.options[k].value, lit)}`).join("|")}}`];
      case TYPE.plural: return [`{${e.value},${e.pluralType}:${Object.keys(e.options).sort().map((k) => `${k}=${sig(e.options[k].value, lit, true)}`).join("|")}}`];
      default: return [];
    }
  });
  return parts.sort().join(",");
}

/**
 * ICU check. Returns null when the source is not ICU MessageFormat (caller uses the regex check).
 * Otherwise the output must parse, keep the same arguments and types, keep every source selector, and may only
 * ADD Arabic plural categories zero/two/few/many whose structure equals the source's "other" branch.
 */
export function icuValid(src: string, out: string, literalCheck: (a: string, b: string) => boolean): boolean | null {
  if (!isIcuSource(src)) return null;
  const a = tryParse(src); if (!a) return null;
  const b = tryParse(out); if (!b) return false;
  const la: string[] = [], lb: string[] = [];
  const reduce = (els: MessageFormatElement[]): MessageFormatElement[] => els.map((e) => {
    if (e.type !== TYPE.plural) return e;
    const srcPl = findPlural(a, e.value, e.pluralType);
    const keep: typeof e.options = {};
    for (const [k, v] of Object.entries(e.options)) {
      if (srcPl && !(k in srcPl.options)) {
        if (!ARABIC_EXTRA.has(k)) { keep["__bad_" + k] = v; continue; }
        const ref = e.options.other ?? srcPl.options.other;
        if (sig(v.value, []) !== sig(ref.value, [], true) && sig(v.value, [], true) !== sig(ref.value, [], true)) keep["__bad_" + k] = v;
        continue; // valid extra Arabic category: dropped from comparison
      }
      keep[k] = { value: reduce(v.value) };
    }
    return { ...e, options: keep };
  });
  return sig(a, la) === sig(reduce(b), lb) && literalCheck(la.join(" "), lb.join(" "));
}
function findPlural(els: MessageFormatElement[], name: string, pt: string): any {
  for (const e of els) {
    if (e.type === TYPE.plural && e.value === name && e.pluralType === pt) return e;
    const kids = e.type === TYPE.plural || e.type === TYPE.select ? Object.values(e.options).map((o) => o.value) : e.type === TYPE.tag ? [e.children] : [];
    for (const k of kids) { const r = findPlural(k, name, pt); if (r) return r; }
  }
  return null;
}
