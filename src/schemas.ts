import { MAX_INPUT_CHARS, MODEL, LOCALIZE_MAX_KEYS, LOCALIZE_MAX_CHARS, TRIAL_MAX_CHARS } from "./config";

const verbatimReport = { type: "object", properties: { ok: { type: "boolean" }, addresses: { type: "array", items: { type: "string" } }, urls: { type: "array", items: { type: "string" } }, numbers: { type: "array", items: { type: "string" } } } };
export const checksSchema = {
  type: "object", description: "Post-check report. verbatim lists 0x addresses/URLs/numbers that were not preserved (empty when ok). Address/URL loss is never served (502, not charged).",
  properties: { verbatim: verbatimReport, retried: { type: "boolean" }, glossary: { type: "string" }, glossaryMissing: { type: "array", items: { type: "string" } } },
};

export const translateInput = {
  type: "object", additionalProperties: false, required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: MAX_INPUT_CHARS, description: "Text to translate (Arabic incl. Saudi/Gulf dialect, or English)." },
    direction: { type: "string", enum: ["auto", "ar-en", "en-ar"], default: "auto", description: "auto detects from script." },
    glossary: { type: "string", enum: ["web3"], description: "Apply a fixed Arabic Web3 terminology list (wallet, gas, smart contract, staking, bridge, DEX, seed phrase...). Reviewed by Nouf 2026-10-31; 91 terms with accepted Arabic forms." },
  },
};
export const translateOutput = {
  type: "object", required: ["translation", "direction", "model", "checks"],
  properties: { translation: { type: "string" }, direction: { type: "string", enum: ["ar-en", "en-ar"] }, model: { type: "string" }, checks: checksSchema },
};
export const summarizeInput = {
  type: "object", additionalProperties: false, required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: MAX_INPUT_CHARS, description: "Arabic or English text to summarize." },
    length: { type: "string", enum: ["short", "medium", "long"], default: "medium", description: "short≈1-2 sentences, medium≈3-5, long≈1-2 paragraphs." },
  },
};
export const summarizeOutput = {
  type: "object", required: ["summary", "length", "model", "checks"],
  properties: { summary: { type: "string", description: "Arabic (MSA) summary." }, length: { type: "string" }, model: { type: "string" }, checks: checksSchema },
};
export const dialectInput = {
  type: "object", additionalProperties: false, required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: MAX_INPUT_CHARS, description: "Arabic text: Saudi/Gulf dialect (dialect-msa) or MSA (msa-dialect)." },
    direction: { type: "string", enum: ["dialect-msa", "msa-dialect"], default: "dialect-msa", description: "dialect-msa: Saudi/Gulf dialect -> فصحى. msa-dialect: فصحى -> natural Saudi/Gulf dialect." },
    dialect: { type: "string", enum: ["saudi", "gulf"], default: "saudi", description: "Dialect of the input (dialect-msa) or target (msa-dialect)." },
  },
};
export const dialectOutput = {
  type: "object", required: ["text", "direction", "dialect", "model", "checks"],
  properties: { text: { type: "string" }, direction: { type: "string", enum: ["dialect-msa", "msa-dialect"] }, dialect: { type: "string", enum: ["saudi", "gulf"] }, model: { type: "string" }, checks: checksSchema },
};
export const localizeInput = {
  type: "object", additionalProperties: false, required: ["json"],
  properties: {
    json: { type: "object", description: `i18n resource object (nested allowed, depth <= 8). Max ${LOCALIZE_MAX_KEYS} string values and ${LOCALIZE_MAX_CHARS} characters across all strings. Keys are never changed; non-string values pass through.`, additionalProperties: true },
  },
};
export const localizeOutput = {
  type: "object", required: ["json", "localized", "total", "model", "checks"],
  properties: {
    json: { type: "object", description: "Same key set as the input, string values localized to Arabic.", additionalProperties: true },
    checks: { type: "object", required: ["fallbackKeys"], properties: { fallbackKeys: { type: "array", items: { type: "string" }, description: "JSON Pointers of strings that failed validation twice and were returned as the source string (at most 20% of strings; above that the call fails with 502 and is not charged)." }, fallbackRatio: { type: "number" }, retried: { type: "integer" } } },
    localized: { type: "integer" }, total: { type: "integer" }, model: { type: "string" },
  },
};
export const trialInput = {
  type: "object", additionalProperties: false, required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: TRIAL_MAX_CHARS, description: `Free trial: up to ${TRIAL_MAX_CHARS} characters.` },
    direction: { type: "string", enum: ["auto", "ar-en", "en-ar"], default: "auto" },
  },
};
export const trialOutput = {
  type: "object", required: ["translation", "direction", "model", "trial"],
  properties: { translation: { type: "string" }, direction: { type: "string" }, model: { type: "string" }, trial: { type: "boolean" }, checks: checksSchema, paid: { type: "string" } },
};
export const errorSchema = { type: "object", required: ["error"], properties: { error: { type: "string" }, detail: { type: "string" } } };

const okChecks = { verbatim: { ok: true, addresses: [], urls: [], numbers: [] }, retried: false };
export const examples = {
  translate: { req: { text: "Send 25 USDC to 0x5cb7Cc71c117675ef36102eaed7a5Aa78A29B29a and keep your seed phrase offline.", direction: "en-ar", glossary: "web3" }, res: { translation: "أرسل 25 USDC إلى 0x5cb7Cc71c117675ef36102eaed7a5Aa78A29B29a واحتفظ بعبارة الاسترداد دون اتصال بالإنترنت.", direction: "en-ar", model: MODEL, checks: { ...okChecks, glossary: "web3", glossaryMissing: [] } } },
  summarize: { req: { text: "Base is an Ethereum L2 incubated by Coinbase...", length: "short" }, res: { summary: "Base هي شبكة طبقة ثانية لإيثريوم طوّرتها Coinbase.", length: "short", model: MODEL, checks: okChecks } },
  dialect: { req: { text: "وش رايك نروح بكرة الساعة 5؟ ابي اشوف المحفظة الجديدة", direction: "dialect-msa", dialect: "saudi" }, res: { text: "ما رأيك أن نذهب غدًا الساعة 5؟ أريد أن أرى المحفظة الجديدة.", direction: "dialect-msa", dialect: "saudi", model: MODEL, checks: okChecks } },
  localize: { req: { json: { greeting: "Hello, {name}!", items: "{count, plural, one {# item} other {# items}}", cta: "Click <b>Connect wallet</b>", fee: "Fee: %s USDC" } },
    res: { json: { greeting: "مرحبًا، {name}!", items: "{count, plural, one {# عنصر} other {# عناصر}}", cta: "انقر على <b>ربط المحفظة</b>", fee: "الرسوم: %s USDC" }, localized: 4, total: 4, model: MODEL, checks: { fallbackKeys: [], fallbackRatio: 0, retried: 0 } } },
  trial: { req: { text: "مرحبا بالعالم", direction: "auto" }, res: { translation: "Hello, world", direction: "ar-en", model: MODEL, trial: true } },
};
