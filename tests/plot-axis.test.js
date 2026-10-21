import test from "node:test";
import assert from "node:assert/strict";
import { valueAxis, axisFraction, niceStep } from "../src/plot-axis.js";

test("sensor axes retain their original scale while every tick and position stays finite", () => {
  for (const [minimum, maximum] of [[0, 0], [-0.4, 312.2], [-1e308, 1e308],
    [0, Number.MAX_VALUE], [-Number.MAX_VALUE, 0], [-Number.MIN_VALUE, Number.MIN_VALUE]]) {
    for (const options of [{}, { intervals: 5, padNegative: true }]) {
      const axis = valueAxis(minimum, maximum, options);
      assert.ok(Number.isFinite(axis.min) && Number.isFinite(axis.max));
      assert.ok(axis.min <= minimum && axis.max >= maximum && axis.max > axis.min);
      assert.ok(Number.isFinite(axis.step) && axis.step > 0);
      assert.ok(axis.ticks.length >= 2 && axis.ticks.length <= 12);
      assert.equal(axis.ticks[0], axis.min);
      assert.equal(axis.ticks.at(-1), axis.max);
      axis.ticks.forEach((tick, index) => {
        assert.ok(Number.isFinite(tick));
        if (index) assert.ok(tick > axis.ticks[index - 1]);
        const position = axisFraction(tick, axis);
        assert.ok(Number.isFinite(position) && position >= 0 && position <= 1);
      });
      assert.equal(axisFraction(axis.min, axis), 0);
      assert.equal(axisFraction(axis.max, axis), 1);
    }
  }
});

test("ordinary video axes retain rounded readable bounds and zero baselines", () => {
  assert.deepEqual(valueAxis(0, 312.2), { min: 0, max: 400, step: 200, ticks: [0, 200, 400] });
  assert.deepEqual(valueAxis(0, 0), { min: 0, max: 1, step: 1, ticks: [0, 1] });
  assert.equal(niceStep(0.051), 0.1);
  assert.ok(Number.isFinite(niceStep(Number.MAX_VALUE)));
});
