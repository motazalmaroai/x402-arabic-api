import test from "node:test";
import assert from "node:assert/strict";
import { capAtomic, checkRequirement, filterRequirements, decodePaymentRequired, EXPECTED } from "../dist/guard.js";
const good = { scheme: "exact", network: EXPECTED.network, amount: "50000", asset: EXPECTED.asset, payTo: EXPECTED.payTo };
const hdr = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
test("cap default 0.10 and parsing", () => {
  assert.equal(capAtomic(undefined), 100000n); assert.equal(capAtomic("0.05"), 50000n); assert.equal(capAtomic("1"), 1000000n);
  assert.throws(() => capAtomic("-1")); assert.throws(() => capAtomic("abc"));
});
test("accepts matching terms under cap", () => { assert.equal(checkRequirement(good, 100000n), null); assert.equal(checkRequirement({ ...good, payTo: good.payTo.toLowerCase() }, 100000n), null); });
test("refuses above cap", () => { assert.match(checkRequirement({ ...good, amount: "150000" }, 100000n), /exceeds cap/); assert.match(checkRequirement({ ...good, amount: "70000" }, 50000n), /exceeds cap/); });
test("refuses mismatches", () => {
  assert.match(checkRequirement({ ...good, network: "eip155:84532" }, 100000n), /network/);
  assert.match(checkRequirement({ ...good, asset: "0x0000000000000000000000000000000000000001" }, 100000n), /asset/);
  assert.match(checkRequirement({ ...good, payTo: "0x000000000000000000000000000000000000dEaD" }, 100000n), /payTo/);
  assert.match(checkRequirement({ ...good, scheme: "upto" }, 100000n), /scheme/);
  assert.match(checkRequirement({ ...good, amount: "1e9" }, 100000n), /invalid amount/);
});
test("policy filter on mocked 402", () => {
  const pr = decodePaymentRequired(hdr({ x402Version: 2, accepts: [{ ...good, payTo: "0x000000000000000000000000000000000000dEaD" }, { ...good, amount: "999999" }, good] }));
  assert.deepEqual(filterRequirements(pr.accepts, 100000n), [good]);
  assert.throws(() => decodePaymentRequired(null)); assert.throws(() => decodePaymentRequired(hdr({})));
});
import { totalCapAtomic, SessionBudget } from "../dist/guard.js";
test("total cap default 0.50 and parsing", () => {
  assert.equal(totalCapAtomic(undefined), 500000n); assert.equal(totalCapAtomic(""), 500000n); assert.equal(totalCapAtomic("1.25"), 1250000n);
  assert.throws(() => totalCapAtomic("x"));
});
test("0.05 + 0.07 pass under 0.50", () => {
  const b = new SessionBudget(totalCapAtomic(undefined));
  assert.equal(b.reserve(50000n), null); b.commit(50000n);
  assert.equal(b.reserve(70000n), null); b.commit(70000n);
  assert.equal(b.spent, 120000n); assert.equal(b.reserved, 0n);
});
test("refuses once total cap would be exceeded; release frees reservation", () => {
  const b = new SessionBudget(100000n);
  assert.equal(b.reserve(50000n), null); b.commit(50000n);
  assert.match(b.reserve(70000n), /MAX_TOTAL_USDC/); assert.equal(b.reserved, 0n);
  assert.equal(b.reserve(50000n), null); b.release(50000n); assert.equal(b.spent, 50000n);
  assert.equal(b.reserve(50000n), null); b.commit(50000n);
  assert.match(b.check(1n), /above cap/);
});
