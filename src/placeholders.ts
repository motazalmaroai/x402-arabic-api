/** Placeholder signature of an i18n string: every token that must survive localization byte-for-byte. */
const PATTERNS: RegExp[] = [
  /\{\{\{?\s*[^{}]+?\s*\}?\}\}/g,                                   // {{count}}, {{{html}}} (mustache / i18next)
  /\{\s*[A-Za-z_$][\w$.]*\s*,\s*(?:plural|select|selectordinal|number|date|time)\b[^{}]*?,?/g, // ICU head: "{count, plural,"
  /(?<=[\s,{}])(?:=\d+|zero|one|two|few|many|other)\s*(?=\{)/g,     // ICU selectors inside an ICU block: "one {", "=0 {"
  /(?<![{\w])\{\s*[A-Za-z_$][\w$.]*\s*\}(?!\})/g,                  // {name}, {user.name}
  /(?<![{\w])\{\d+\}(?!\})/g,                                       // {0}
  /%(?:\d+\$)?[-+ 0#]*\d*(?:\.\d+)?[sdifuxXeEgGc@%]/g,              // %s %d %1$s %.2f %%
  /:[A-Za-z_]\w*\b(?=[\s.,!?)]|$)/g,                                // :name (Laravel/Rails style)
  /<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/g,                          // HTML/JSX tags with attributes, verbatim
  /&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g,                           // HTML entities
];
export function placeholders(s: string): string[] {
  const out: string[] = [];
  const isIcu = /\{\s*[A-Za-z_$][\w$.]*\s*,\s*(?:plural|select|selectordinal)\b/.test(s);
  PATTERNS.forEach((re, i) => {
    if (i === 2 && !isIcu) return;
    if (i === 6 && !/(^|\s):[A-Za-z_]\w*/.test(s)) return;
    for (const m of s.match(re) ?? []) out.push(i === 1 ? m.replace(/\s+/g, "") : i === 2 ? m.trim() : m);
  });
  if (isIcu) for (const _ of s.match(/#/g) ?? []) out.push("#"); // ICU plural "#" count marker
  return out.sort();
}
export function samePlaceholders(src: string, out: string): boolean {
  const a = placeholders(src), b = placeholders(out);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
/** Balanced braces are required for ICU to parse at all. */
export function bracesBalanced(s: string): boolean {
  let d = 0; for (const ch of s) { if (ch === "{") d++; else if (ch === "}" && --d < 0) return false; } return d === 0;
}
