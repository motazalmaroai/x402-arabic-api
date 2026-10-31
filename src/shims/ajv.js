// Workers shim for ajv (aliased in wrangler.toml only; vitest/Node uses the real ajv, so the
// bazaar schemas are still validated in tests). ajv.compile code-generates via `new Function`,
// which Workers forbid, so real validation can't run there anyway; this avoids ~290 KiB of
// bundle and a costly failing compile inside a (possibly paid) first request in a cold isolate.
export default class Ajv {
  compile() { const v = () => true; v.errors = null; return v; }
}
