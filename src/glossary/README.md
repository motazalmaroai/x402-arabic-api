# Glossaries

## `web3.json` — **DRAFT: pending review by Nouf**

Proposed Arabic Web3 terminology (56 entries) used by `POST /translate-ar` with `"glossary": "web3"`.

- **Status:** reviewed by Nouf 2026-10-31 (91 terms). `ar` is an array of accepted forms without diacritics or a leading ال; the prompt uses the first form, the check accepts any form, after stripping diacritics and the article from the model output. Tickers, project/network names, addresses, ENS names, hashes, URLs, code and EVM/ERC/EIP/RPC/gwei/APY/APR/MEV/ZK/L2 stay in Latin script.
- **How it is enforced:** only terms whose English (en→ar) or Arabic (ar→en) form occurs in the input are injected into the system prompt as REQUIRED renderings; after generation a post-check verifies each matched term's target form appears in the output. On a miss the call is retried once with the missing terms called out; remaining misses are reported in `checks.glossaryMissing` (the response is still served).
- **Matching:** `en` entries are matched case-insensitively on word boundaries, longest phrase first (so "gas fee" wins over "gas"). Arabic side is a substring check (so `المحفظة` satisfies `محفظة`, but a broken plural such as `محافظ` does not and will be flagged).
- Items for Nouf: `staking`=التخزين vs التكديس; `airdrop`=توزيع مجاني vs إسقاط جوي; `token`=رمز مميز vs توكن; `oracle`=أوراكل vs وسيط بيانات; `mint`=سكّ; `hash`=التجزئة.
