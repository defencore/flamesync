import test from "node:test";
import assert from "node:assert/strict";
import { parseCSV } from "../src/data.js";
import { analyseProfile, profileMapping } from "../src/profiles/model.js";
import { UserError } from "../src/messages.js";
import { alignTheory, comparisonToTheory, mapTheoryToView, validateTheoryMapping } from "../src/theory.js";

const near = (actual, expected, epsilon = 1e-9) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= epsilon, `${actual} ≠ ${expected}`);

function sampled({ start = 0, duration = 4, rate = 50, unit = "s", thrust = 100, pressure = 2, settings = { thrustUnit: "N", pressureUnit: "bar" } } = {}) {
  const factor = { s: 1, ms: 1e3, us: 1e6 }[unit];
  const rows = Array.from({ length: Math.round(duration * rate) + 1 }, (_, i) => {
    const time = start + i / rate;
    return `${time * factor};${typeof thrust === "function" ? thrust(time - start) : thrust};${typeof pressure === "function" ? pressure(time - start) : pressure}`;
  });
  return parseCSV(`time_${unit};thrust;pressure\n${rows.join("\n")}`, settings);
}

function profile(data, start, end) {
  return analyseProfile(data, { start, end });
}

test("theory ignition alignment preserves original durations across clocks, sampling rates, and units", () => {
  const measuredData = sampled({ start: 10, rate: 120, unit: "us" });
  const theoryData = sampled({ start: 20, duration: 6, rate: 40, unit: "ms" });
  const measured = profile(measuredData, 11, 13);
  const theory = profile(theoryData, 21, 25);
  assert.deepEqual(alignTheory(measured, theory), { offset: -10, scale: 1 });
  assert.deepEqual(alignTheory(measured, theory, "burnout"), { offset: -12, scale: 1 });
  assert.deepEqual(alignTheory(measured, theory, "source"), { offset: 0, scale: 1 });
  near(measured.duration, 2);
  near(theory.duration, 4);
  near(measured.impulse, 200);
  near(theory.impulse, 400);
});

test("only explicit both-event alignment retimes theory and composes with normalized views", () => {
  const measured = { start: 11, end: 13 };
  const theory = { start: 21, end: 25 };
  const mapping = alignTheory(measured, theory, "both");
  assert.deepEqual(mapping, { offset: 0.5, scale: 0.5 });
  near(mapping.offset + theory.start * mapping.scale, measured.start);
  near(mapping.offset + theory.end * mapping.scale, measured.end);
  const view = mapTheoryToView(profileMapping(measured, "normalized"), mapping);
  near(view.offset + theory.start * view.scale, 0);
  near(view.offset + theory.end * view.scale, 100);
  assert.deepEqual(measured, { start: 11, end: 13 });
  assert.deepEqual(theory, { start: 21, end: 25 });
});

test("missing burn events stay unavailable rather than becoming guessed anchors", () => {
  for (const absent of [null, undefined, NaN, Infinity]) {
    assert.equal(alignTheory({ start: absent, end: 3 }, { start: 2, end: 4 }), null);
    assert.equal(alignTheory({ start: 1, end: 3 }, { start: absent, end: 4 }), null);
    assert.equal(alignTheory({ start: 1, end: absent }, { start: 2, end: 4 }, "burnout"), null);
    assert.equal(alignTheory({ start: 1, end: 3 }, { start: 2, end: absent }, "both"), null);
  }
  assert.equal(alignTheory({ start: 3, end: 1 }, { start: 2, end: 4 }, "both"), null);
  assert.deepEqual(alignTheory(null, null, "source"), { offset: 0, scale: 1 });
  assert.equal(mapTheoryToView(null, { offset: 0, scale: 1 }), null);
  assert.equal(mapTheoryToView({ offset: 0, scale: 1 }, null), null);
  assert.throws(() => alignTheory({}, {}, "automatic"), UserError);
});

test("mapping validation accepts finite arbitrary offsets and positive scales without hidden frame assumptions", () => {
  for (const mapping of [null, {}, { offset: NaN, scale: 1 }, { offset: Infinity, scale: 1 }, { offset: 0, scale: 0 }, { offset: 0, scale: -1 }, { offset: 0, scale: Infinity }])
    assert.throws(() => validateTheoryMapping(mapping), UserError);
  const mapping = { offset: -100, scale: 12 };
  assert.equal(validateTheoryMapping(mapping), mapping);
  assert.deepEqual(mapTheoryToView({ offset: 2, scale: 3 }, mapping), { offset: -298, scale: 36 });
  assert.throws(() => mapTheoryToView({ offset: NaN, scale: 1 }, mapping), UserError);
  assert.throws(() => mapTheoryToView({ offset: Number.MAX_VALUE, scale: 2 }, { offset: Number.MAX_VALUE, scale: 1 }), UserError);
  assert.throws(() => alignTheory({ start: Number.MAX_VALUE }, { start: -Number.MAX_VALUE }), UserError);
});

test("measured-minus-theory metrics use canonical N and bar with explicit kgf source settings", () => {
  const gravity = 9.80665;
  const measuredData = sampled({ start: 10, rate: 120, unit: "us", thrust: 11, pressure: 2.2, settings: { thrustUnit: "kgf", pressureUnit: "bar" } });
  const theoryData = sampled({ start: 20, rate: 50, unit: "ms", thrust: 10 * gravity, pressure: 2 });
  const measured = profile(measuredData, 11, 13);
  const theory = profile(theoryData, 21, 23);
  const comparison = comparisonToTheory(measuredData, measured, theoryData, theory, alignTheory(measured, theory));
  near(comparison.start, 11);
  near(comparison.end, 13);
  near(comparison.duration, 2);
  near(comparison.coverage, 1);
  for (const key of ["bias", "mae", "rmse", "maxAbs"]) {
    near(comparison.thrust[key], gravity);
    near(comparison.pressure[key], 0.2);
  }
  near(measured.impulse, 22 * gravity);
  near(theory.impulse, 20 * gravity);
  assert.ok(comparison.points.every(({ t }) => t >= 11 && t <= 13));
});

test("comparison is restricted to common selected burn boundaries and never extrapolates", () => {
  const measuredData = sampled({ thrust: 110 });
  const theoryData = sampled({ duration: 2, thrust: (time) => time < 1 ? 100 : 200 });
  const measured = profile(measuredData, 1, 3);
  const theory = profile(theoryData, 0, 1);
  const comparison = comparisonToTheory(measuredData, measured, theoryData, theory, { offset: 1, scale: 1 });
  near(comparison.start, 1);
  near(comparison.end, 2);
  near(comparison.duration, 1);
  assert.ok(comparison.points.every(({ t }) => t >= 1 && t <= 2));
  assert.equal(comparisonToTheory(measuredData, measured, theoryData, theory, { offset: 100, scale: 1 }), null);
  assert.equal(comparisonToTheory(measuredData, { start: null, end: 3 }, theoryData, theory, { offset: 1, scale: 1 }), null);
  assert.equal(comparisonToTheory(measuredData, measured, theoryData, theory, null), null);
  assert.throws(() => comparisonToTheory(measuredData, measured, theoryData, theory, { offset: 0, scale: -1 }), UserError);
});

test("gaps contribute no theoretical error samples or invented duration", () => {
  const measuredData = parseCSV("time_s;thrust;pressure\n0;110;2.2\n0.1;110;2.2\n0.2;110;2.2\n2;110;2.2\n2.1;110;2.2\n2.2;110;2.2", { thrustUnit: "N" });
  const theoryData = sampled({ duration: 2.2, rate: 50 });
  const measured = profile(measuredData, 0, 2.2);
  const theory = profile(theoryData, 0, 2.2);
  const comparison = comparisonToTheory(measuredData, measured, theoryData, theory, alignTheory(measured, theory));
  near(comparison.coverage, 0.4 / 2.2);
  near(comparison.thrust.bias, 10);
  near(comparison.thrust.rmse, 10);
  assert.ok(comparison.points.some(({ gapBefore }) => gapBefore));
  assert.ok(comparison.points.every(({ t }) => t <= 0.2 || t >= 2));
  const gapOnly = profile(measuredData, 0.5, 1.5);
  assert.equal(comparisonToTheory(measuredData, gapOnly, theoryData, theory, { offset: 0, scale: 1 }), null);
});

test("explicit duration fitting compares shape while source-domain impulse remains unchanged", () => {
  const measuredData = sampled({ start: 10, duration: 2, thrust: (t) => 20 * t });
  const theoryData = sampled({ start: 20, duration: 4, thrust: (t) => 10 * t });
  const measured = profile(measuredData, 10, 12);
  const theory = profile(theoryData, 20, 24);
  const comparison = comparisonToTheory(measuredData, measured, theoryData, theory, alignTheory(measured, theory, "both"));
  near(comparison.thrust.bias, 0, 1e-12);
  near(comparison.thrust.rmse, 0, 1e-12);
  near(measured.impulse, 40);
  near(theory.impulse, 80);
  near(measured.duration, 2);
  near(theory.duration, 4);
});
