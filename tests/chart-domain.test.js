import test from "node:test";
import assert from "node:assert/strict";
import { overlayTimeDomain } from "../src/chart-domain.js";

const near = (actual, expected, epsilon = 1e-10) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≠ ${expected}`);

function theory(data, stats, offset = 0, timeScale = 1) {
  return { data, stats, offset, timeScale };
}

test("burn view keeps a short firing legible despite a long theoretical baseline tail", () => {
  const measured = { start: -0.62, end: 8 };
  const selected = { start: 0.1, end: 4.307 };
  const calculated = theory({ start: 20, end: 54 }, { start: 21, end: 25.5 }, -20.9);
  const domain = overlayTimeDomain(measured, calculated, selected);
  near(domain.start, -0.26);
  near(domain.end, 4.96);
  near(domain.duration, 5.22);
  assert.ok((selected.end - selected.start) / domain.duration > 0.8);
  assert.ok(domain.start < selected.start && domain.end > 4.6);
});

test("full view retains the exact union of source clocks after theoretical mapping", () => {
  const measured = { start: 10, end: 14 };
  const calculated = theory({ start: 100, end: 120 }, { start: 101, end: 103 }, -190, 2);
  assert.deepEqual(overlayTimeDomain(measured, calculated, { start: 11, end: 13 }, "full"),
    { start: 10, end: 50, duration: 40 });
});

test("burn view includes a genuinely longer theoretical burn without fitting its duration", () => {
  const measured = { start: 50, end: 100 };
  const calculated = theory({ start: 200, end: 300 }, { start: 205, end: 220 }, -350, 2);
  const domain = overlayTimeDomain(measured, calculated, { start: 60, end: 64 });
  near(domain.start, 57.6);
  near(domain.end, 92.4);
  assert.ok(domain.start < 60 && domain.end > 90);
  assert.equal(calculated.timeScale, 2);
});

test("one known burn provides focus while an unknown interval never compresses it", () => {
  const measured = { start: 0, end: 10 };
  const calculated = theory({ start: 100, end: 200 }, { start: 110, end: 112 }, -109);
  assert.deepEqual(overlayTimeDomain(measured, calculated, { start: 1, end: null }),
    { start: 0.84, end: 3.16, duration: 2.3200000000000003 });
  const incompleteTheory = theory(calculated.data, { start: null, end: 112 }, -100);
  assert.deepEqual(overlayTimeDomain(measured, incompleteTheory, { start: 1, end: 3 }),
    { start: 0.84, end: 3.16, duration: 2.3200000000000003 });
  assert.deepEqual(overlayTimeDomain(measured, incompleteTheory, null),
    { start: 0, end: 100, duration: 100 });
});

test("invalid or out-of-source A/B cannot silently crop the original log", () => {
  const source = { start: -10, end: -2 };
  for (const selected of [null, {}, { start: -5, end: -5 }, { start: -3, end: -7 },
    { start: -11, end: -4 }, { start: -9, end: 0 }, { start: NaN, end: -3 },
    { start: -8, end: Infinity }]) {
    const domain = overlayTimeDomain(source, null, selected);
    assert.deepEqual(domain, { start: -10, end: -2, duration: 8 });
  }
});

test("disabled, malformed, or non-finite theory maps do not change the measured domain", () => {
  const source = { start: 0, end: 10 };
  const selected = { start: 2, end: 4 };
  const expected = overlayTimeDomain(source, null, selected);
  const reference = theory({ start: 1, end: 100 }, { start: 2, end: 90 });
  for (const disabled of [null, { ...reference, enabled: false },
    { ...reference, offset: NaN }, { ...reference, offset: Infinity },
    { ...reference, timeScale: 0 }, { ...reference, timeScale: -1 },
    { ...reference, timeScale: Infinity },
    { ...reference, offset: Number.MAX_VALUE, timeScale: Number.MAX_VALUE }])
    assert.deepEqual(overlayTimeDomain(source, disabled, selected), expected);
});

test("the same clock domain serves all signals without interpolating gaps or inspecting sensor amplitudes", () => {
  const source = Object.freeze({ start: 2000, end: 2030, peakPressure: 0,
    points: Object.freeze([Object.freeze({ t: 2000, thrust: 0, pressure: 0 }),
      Object.freeze({ t: 2002, thrust: 20, pressure: 0, gapBefore: true }),
      Object.freeze({ t: 2030, thrust: 0, pressure: 0 })]) });
  const selected = Object.freeze({ start: 2001, end: 2005 });
  const domain = overlayTimeDomain(source, null, selected);
  near(domain.start, 2000.68);
  near(domain.end, 2005.32);
  near(domain.duration, 4.64);
  assert.equal(source.points[1].gapBefore, true);
});

test("burn mapping handles negative, nonzero, and sub-microsecond source clocks without normalization", () => {
  const source = { start: -10, end: -9 };
  const calculated = theory({ start: 100, end: 110 }, { start: 101, end: 102 }, -110, 1);
  const domain = overlayTimeDomain(source, calculated, { start: -9.8, end: -9.5 });
  near(domain.start, -9.944);
  near(domain.end, -7.856);
  const tiny = overlayTimeDomain({ start: 0, end: 1e-8 }, null, { start: 1e-9, end: 2e-9 });
  near(tiny.start, 0.92e-9, 1e-20);
  near(tiny.end, 2.08e-9, 1e-20);
  assert.ok(tiny.duration > 0 && tiny.duration < 2e-9);
});

test("view construction leaves source bounds, selected events, theoretical statistics, and mapping unchanged", () => {
  const source = Object.freeze({ start: 1, end: 100 });
  const selected = Object.freeze({ start: 2, end: 6 });
  const calculated = Object.freeze(theory(Object.freeze({ start: 50, end: 70 }),
    Object.freeze({ start: 51, end: 57, impulse: 123 }), -100, 2));
  const snapshot = JSON.stringify({ source, selected, calculated });
  overlayTimeDomain(source, calculated, selected);
  overlayTimeDomain(source, calculated, selected, "full");
  assert.equal(JSON.stringify({ source, selected, calculated }), snapshot);
});

test("hiding A/B annotations does not change the selected burn viewport", () => {
  const source = { start: 0, end: 100 };
  const selected = { start: 2, end: 6 };
  assert.deepEqual(overlayTimeDomain(source, null, { ...selected, visible: false }),
    overlayTimeDomain(source, null, { ...selected, visible: true }));
});

test("empty and numerically unrepresentable domains remain finite without creating burn anchors", () => {
  for (const source of [null, undefined, { start: 1, end: 1 }, { start: Infinity, end: 3 },
    { start: -Number.MAX_VALUE, end: Number.MAX_VALUE }])
    assert.deepEqual(overlayTimeDomain(source), { start: 0, end: 1, duration: 1 });
  const large = { start: Number.MAX_VALUE * 0.8, end: Number.MAX_VALUE };
  const domain = overlayTimeDomain(large, null, large);
  assert.deepEqual(domain, { ...large, duration: large.end - large.start });
  for (const value of Object.values(domain)) assert.ok(Number.isFinite(value));
});
