import test from "node:test";
import assert from "node:assert/strict";
import { finiteAnalysis, linearFraction, linearRms, linearValue, positiveArea } from "../src/signal-math.js";
import { UserError } from "../src/messages.js";

const relative = (value, expected) => assert.ok(
  Number.isFinite(value) && Math.abs(value / expected - 1) < 1e-14,
  `${value} differs from ${expected}`,
);

test("linear interpolation preserves finite opposite extremes, exact endpoints and small baseline variation", () => {
  assert.equal(linearValue(-1e308, 1e308, 0.5), 0);
  relative(linearValue(-1e308, 1e308, 0.75), 5e307);
  assert.equal(linearValue(1e12, 1e12 + 2, 0.5), 1e12 + 1);
  assert.equal(linearValue(Number.MAX_VALUE, Number.MAX_VALUE, 0.6), Number.MAX_VALUE);
  assert.equal(linearValue(Number.MIN_VALUE, Number.MIN_VALUE, 0.5), Number.MIN_VALUE);
  assert.equal(linearValue(-1e308, 1e308, 0), -1e308);
  assert.equal(linearValue(-1e308, 1e308, 1), 1e308);
  relative(linearFraction(-1e308, 1e308, 5e306), 0.525);
});

test("linear RMS normalizes before squaring and positive area retains negative-baseline zero crossings", () => {
  relative(linearRms(-1e200, 1e200), 1e200 / Math.sqrt(3));
  relative(linearRms(1e308, 1e308), 1e308);
  relative(positiveArea(-1e308, 1e308, 1), 2.5e307);
  assert.equal(positiveArea(Number.MIN_VALUE, Number.MIN_VALUE, 1), Number.MIN_VALUE);
  assert.equal(finiteAnalysis(1e308), 1e308);
  assert.throws(() => finiteAnalysis(Infinity), UserError);
  assert.throws(() => finiteAnalysis(NaN), UserError);
});
