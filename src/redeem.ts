/**
 * Lost-response redeem (risk-manager design) + hand-written payment validation.
 *
 * After generation and BEFORE settle, the exact response body is stored in KV:
 *   key   = sha256(chainId | asset | from | nonce)  (EIP-3009 authorization identity)
 *   value = { h: sha256(full PAYMENT-SIGNATURE header), path, body }  — never the client's input text
 *   TTL   = 3600 s
 * If the identical payment arrives again (nonce already claimed) AND the on-chain USDC authorizationState(from, nonce)
 * is true (i.e. the transfer to payTo really executed), the stored body is returned with 200 and NO new settle.
 * Different payload hash, no stored body, or authorization not used on-chain => 409. RPC unavailable => 503.
 */
export const REDEEM_TTL_SEC = 3600;
export const AUTH_STATE_SELECTOR = "0xe94a0102"; // keccak256("authorizationState(address,bytes32)")[:4]

const lc = (s: unknown) => String(s ?? "").toLowerCase();
const ADDR = /^0x[0-9a-f]{40}$/;
const UINT = /^[0-9]{1,78}$/;

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const redeemKey = (chainId: string, asset: string, from: string, nonce: string) =>
  sha256Hex(`${chainId}|${lc(asset)}|${lc(from)}|${lc(nonce)}`).then((h) => `redeem:${h}`);

export interface Expected { network: string; asset: string; payTo: string; amount: string; nowSec?: number }

/**
 * Manual validation of every payment field we rely on (independent of any JSON-schema library).
 * Returns null if OK, else a short reason. Runs before the nonce claim / verify.
 */
export function validatePayment(p: any, e: Expected): string | null {
  if (!p || typeof p !== "object") return "payload_not_object";
  if (p.x402Version !== 2) return "bad_x402_version";
  const a = p.accepted;
  if (!a || typeof a !== "object") return "missing_accepted";
  if (a.scheme !== "exact") return "bad_scheme";
  if (a.network !== e.network) return "bad_network";
  if (lc(a.asset) !== lc(e.asset)) return "bad_asset";
  if (lc(a.payTo) !== lc(e.payTo)) return "bad_pay_to";
  if (String(a.amount) !== e.amount) return "bad_amount";
  const sig = p.payload?.signature, au = p.payload?.authorization;
  if (!au || typeof au !== "object") return "missing_authorization";
  if (!ADDR.test(lc(au.from))) return "bad_from";
  if (lc(au.to) !== lc(e.payTo)) return "bad_authorization_to";
  if (String(au.value) !== e.amount) return "bad_authorization_value";
  const va = String(au.validAfter), vb = String(au.validBefore);
  if (!UINT.test(va) || !UINT.test(vb)) return "bad_validity_format";
  const now = BigInt(e.nowSec ?? Math.floor(Date.now() / 1000));
  if (BigInt(va) > now) return "not_yet_valid";
  if (BigInt(vb) <= now + 6n) return "expired_or_expiring"; // must outlive settle
  if (!/^0x[0-9a-f]{64}$/.test(lc(au.nonce))) return "bad_nonce_format";
  // 65-byte ECDSA (EOA) or a longer EIP-1271/6492 smart-wallet signature: 0x-hex, even length, bounded.
  if (typeof sig !== "string" || !/^0x([0-9a-fA-F]{2}){65,2048}$/.test(sig)) return "bad_signature_format";
  return null;
}

/** On-chain proof the EIP-3009 authorization was executed. true/false, or null if every RPC failed. */
export async function authorizationUsed(rpcs: string[], asset: string, from: string, nonce: string, f: typeof fetch = fetch): Promise<boolean | null> {
  const data = AUTH_STATE_SELECTOR + lc(from).slice(2).padStart(64, "0") + lc(nonce).slice(2).padStart(64, "0");
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: asset, data }, "latest"] });
  for (const u of rpcs) {
    try {
      const r = await f(u, { method: "POST", headers: { "content-type": "application/json" }, body });
      const j: any = await r.json();
      if (typeof j?.result === "string" && /^0x[0-9a-f]*$/i.test(j.result)) return BigInt(j.result === "0x" ? 0 : j.result) !== 0n;
    } catch { /* next RPC */ }
  }
  return null;
}
