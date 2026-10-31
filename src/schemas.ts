import { MAX_INPUT_CHARS } from "./config";

export const translateInput = {
  type: "object", additionalProperties: false, required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: MAX_INPUT_CHARS, description: "Text to translate (Arabic or English)." },
    direction: { type: "string", enum: ["auto", "ar-en", "en-ar"], default: "auto", description: "auto detects from script." },
  },
};
export const translateOutput = {
  type: "object", required: ["translation", "direction", "model"],
  properties: { translation: { type: "string" }, direction: { type: "string", enum: ["ar-en", "en-ar"] }, model: { type: "string" } },
};
export const summarizeInput = {
  type: "object", additionalProperties: false, required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: MAX_INPUT_CHARS, description: "Arabic or English text to summarize." },
    length: { type: "string", enum: ["short", "medium", "long"], default: "medium", description: "short≈1-2 sentences, medium≈3-5, long≈1-2 paragraphs." },
  },
};
export const summarizeOutput = {
  type: "object", required: ["summary", "length", "model"],
  properties: { summary: { type: "string", description: "Arabic (MSA) summary." }, length: { type: "string" }, model: { type: "string" } },
};
export const errorSchema = { type: "object", required: ["error"], properties: { error: { type: "string" }, detail: { type: "string" } } };

export const examples = {
  translate: { req: { text: "تُعدّ الشفافية أحد المبادئ الأساسية لتقنية البلوكتشين.", direction: "auto" }, res: { translation: "Transparency is one of the core principles of blockchain technology.", direction: "ar-en", model: "@cf/qwen/qwen3-30b-a3b-fp8" } },
  summarize: { req: { text: "Base is an Ethereum L2 incubated by Coinbase...", length: "short" }, res: { summary: "Base هي شبكة طبقة ثانية لإيثريوم طوّرتها Coinbase.", length: "short", model: "@cf/qwen/qwen3-30b-a3b-fp8" } },
};
