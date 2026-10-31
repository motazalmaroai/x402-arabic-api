// Bundle-size shim (CPU: less code to parse/compile in cold isolates). Same as zod's classic
// entry, minus the `core` and `locales` namespaces (~400 KiB of locales). English stays the default
// locale (registered by classic/schemas.js). @x402/* only use z.object/string/union/... (verified).
export * from "../../node_modules/zod/v4/classic/schemas.js";
export * from "../../node_modules/zod/v4/classic/checks.js";
export * from "../../node_modules/zod/v4/classic/errors.js";
export * from "../../node_modules/zod/v4/classic/parse.js";
export * from "../../node_modules/zod/v4/classic/compat.js";
export { ZodISODateTime, ZodISODate, ZodISOTime, ZodISODuration } from "../../node_modules/zod/v4/classic/iso.js";
export * as coerce from "../../node_modules/zod/v4/classic/coerce.js";
import * as z from "./zod.js";
export { z, z as default };
