import test from "node:test";
import assert from "node:assert/strict";
import { parseCSV } from "../src/data.js";
import { UserError } from "../src/messages.js";
import { analyseProfile, profileMapping, compareProfiles } from "../src/profiles/model.js";

const near = (actual, expected, epsilon = 1e-9) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= epsilon, `${actual} ≠ ${expected}`);
function csv(rows, unit = "s", settings = {}) {
  const factor = { s: 1, ms: 1e3, us: 1e6 }[unit];
  return parseCSV(
    `time_${unit};thrust;pressure\n` + rows.map(([t, f, p]) => `${t * factor};${f};${p}`).join("\n"),
    settings,
  );
}
function sampled(start, end, step, value) {
  const rows = [];
  for (let i = 0; i <= Math.round((end - start) / step); i++) {
    const t = start + i * step;
    const [thrust, pressure] = value(t);
    rows.push([t, thrust, pressure]);
  }
  return rows;
}

test("burn metrics use original seconds across millisecond/microsecond logs and different sampling rates", () => {
  const shape = (t) => {
    const force = t <= 1 ? t * 100 : (2 - t) * 100;
    return [force, force / 10];
  };
  const profiles = [
    analyseProfile(csv(sampled(0, 2, 0.02, shape), "ms")),
    analyseProfile(csv(sampled(0, 2, 1 / 120, shape), "us")),
    analyseProfile(csv(sampled(0, 2, 0.1, shape), "s")),
  ];
  for (const profile of profiles) {
    near(profile.start, 0.05);
    near(profile.end, 1.95);
    near(profile.duration, 1.9);
    near(profile.impulse, 99.75);
    near(profile.meanThrust, 99.75 / 1.9);
    near(profile.meanPressure, 9.975 / 1.9);
    near(profile.peakThrust, 100);
    near(profile.peakPressure, 10);
    near(profile.coverage, 1);
    near(profile.noiseStart, 0.24);
    near(profile.noiseEnd, 1.76);
  }
});

test("input force/pressure units convert to the same internal physical metrics", () => {
  const seconds = csv([[0, 0, 0], [1, 100, 10], [2, 0, 0]]);
  const converted = csv([[0, 0, 0], [1, 0.1, 1000], [2, 0, 0]], "us", { thrustUnit: "kN", pressureUnit: "kPa" });
  const a = analyseProfile(seconds);
  const b = analyseProfile(converted);
  for (const key of ["duration", "impulse", "meanThrust", "peakThrust", "meanPressure", "peakPressure"])
    near(a[key], b[key]);
  near(b.curves.raw[1].thrust, 100);
  near(b.curves.raw[1].pressure, 10);
});

test("selected integrals interpolate boundaries and clip negative-force zero crossings exactly", () => {
  const data = csv([[0, -10, 0], [2, 10, 20]]);
  const complete = analyseProfile(data, { start: 0, end: 2, massKg: 0.5 });
  near(complete.impulse, 5);
  near(complete.meanThrust, 0);
  near(complete.meanPressure, 10);
  near(complete.specificImpulse, 5 / (0.5 * 9.80665));
  const middle = analyseProfile(data, { start: 0.5, end: 1.5 });
  near(middle.impulse, 1.25);
  near(middle.peakThrust, 5);
  near(middle.peakPressure, 15);
  near(middle.meanPressure, 10);
});

test("measured specific impulse requires positive supplied propellant mass and complete coverage", () => {
  const data = csv([[0, 100, 20], [1, 100, 20], [2, 100, 20]]);
  const result = analyseProfile(data, { start: 0, end: 2, massKg: 0.1 });
  near(result.impulse, 200);
  near(result.specificImpulse, 200 / (0.1 * 9.80665));
  assert.equal(analyseProfile(data, { start: 0, end: 2 }).specificImpulse, null);
  for (const massKg of [0, -1, Infinity, NaN])
    assert.throws(() => analyseProfile(data, { start: 0, end: 2, massKg }), UserError);
  assert.ok(!Object.hasOwn(result, "efficiency"));
});

test("missing boundaries leave metrics unavailable while raw curves remain usable", () => {
  const data = csv([[0, 100, 2], [1, 100, 2], [2, 100, 2]]);
  const detected = analyseProfile(data);
  assert.equal(detected.start, null);
  assert.equal(detected.end, null);
  for (const key of ["duration", "impulse", "meanThrust", "peakThrust", "meanPressure", "peakPressure", "coverage", "specificImpulse", "noiseThrustRms"])
    assert.equal(detected[key], null, key);
  assert.equal(detected.curves.raw.length, 3);
  const explicit = analyseProfile(data, { start: null, end: 2 });
  assert.equal(explicit.start, null);
  assert.equal(explicit.end, 2);
  assert.equal(explicit.duration, null);
  assert.ok(explicit.warnings.some(({ key }) => key.includes("both ignition and burnout")));
});

test("invalid event boundaries, noise windows, intervals, and threshold values fail clearly", () => {
  const data = csv([[0, 0, 0], [1, 100, 10], [2, 0, 0]]);
  for (const options of [
    { start: -1, end: 1 }, { start: 0, end: 3 },
    { start: 1, end: 0.5 }, { start: 1, end: 1 },
    { start: NaN }, { end: Infinity },
    { noiseWindow: 0 }, { noiseWindow: -0.1 }, { noiseWindow: NaN },
    { noiseStart: 1, noiseEnd: 0.5 }, { noiseEnd: 3 },
    { threshold: 0 }, { threshold: 100 },
  ]) assert.throws(() => analyseProfile(data, options), UserError);
});

test("gaps are excluded from integrals and means and suppress specific impulse", () => {
  const data = csv([[0, 100, 20], [0.1, 100, 20], [0.2, 100, 20], [2, 100, 20], [2.1, 100, 20], [2.2, 100, 20]]);
  const result = analyseProfile(data, { start: 0, end: 2.2, massKg: 0.1, noiseStart: 0, noiseEnd: 2.2 });
  near(result.impulse, 40);
  near(result.coverage, 0.4 / 2.2);
  near(result.meanThrust, 100);
  near(result.meanPressure, 20);
  assert.equal(result.specificImpulse, null);
  assert.ok(result.warnings.some(({ key }) => key.includes("specific impulse is unavailable")));
  near(result.noiseThrustRms, 0, 1e-10);
  assert.ok(result.curves.raw.some((point) => point.t === 2 && point.gapBefore));
  assert.ok(result.curves.trend.some((point) => point.gapBefore));
  assert.ok(result.curves.residual.some((point) => point.gapBefore));
  const empty = analyseProfile(data, { start: 0.5, end: 1.5 });
  assert.equal(empty.impulse, null);
  assert.equal(empty.meanThrust, null);
  assert.equal(empty.peakThrust, null);
  assert.equal(empty.coverage, 0);
});

test("centered moving means reject linear ramps without treating real slope as random noise", () => {
  const data = csv([[0, 10, 2], [0.07, 11.4, 2.28], [0.4, 18, 3.6], [1, 30, 6], [2, 50, 10]]);
  const result = analyseProfile(data, { start: 0, end: 2, noiseWindow: 0.6, noiseStart: 0, noiseEnd: 2 });
  near(result.noiseThrustRms, 0, 1e-10);
  near(result.noisePressureRms, 0, 1e-10);
  near(result.curves.trend[0].t, 0.3);
  near(result.curves.trend.at(-1).t, 1.7);
  assert.ok(result.curves.residual.every((point) => Math.abs(point.thrust) < 1e-10));
  assert.ok(result.warnings.some(({ key }) => key.includes("not calibrated uncertainty")));
});

test("constant and affine windows produce exact zero residual rather than cumulative-integration roundoff", () => {
  for (const rate of [20, 60, 120, 700]) {
    for (const shape of [(t) => [100, 2], (t) => [100 + 20 * t, 2 + 4 * t]]) {
      const data = csv(sampled(0, 2, 1 / rate, shape));
      const result = analyseProfile(data, { start: 0, end: 2, noiseWindow: 0.1 });
      assert.equal(result.noiseThrustRms, 0);
      assert.equal(result.noisePressureRms, 0);
      assert.equal(result.noiseThrustPercent, 0);
      assert.equal(result.noisePressurePercent, 0);
      assert.ok(result.curves.residual.every((point) => point.thrust === 0 && point.pressure === 0));
    }
  }
});

test("affine recognition preserves real small residuals and slowly accumulating curvature", () => {
  const ripple = csv(Array.from({ length: 2001 }, (_, i) => [i / 1000, 100 + 1e-8 * (i % 2 ? 1 : -1), 2]));
  const noise = analyseProfile(ripple, { start: 0, end: 2, noiseWindow: 0.1 });
  near(noise.noiseThrustRms, 1e-8 / Math.sqrt(3), 2e-13);
  assert.equal(noise.noisePressureRms, 0);
  // Neighboring slopes differ below signal precision, but curvature over a
  // complete window is resolved. Maximal affine spans must not swallow it.
  const curved = csv(Array.from({ length: 2001 }, (_, i) => {
    const t = i / 1000;
    return [t, 100 + 1e-8 * t * t, 2];
  }));
  const curve = analyseProfile(curved, { start: 0, end: 2, noiseWindow: 0.2 });
  near(curve.noiseThrustRms, 1e-8 * 0.2 ** 2 / 12, 1e-12);
  assert.ok(curve.noiseThrustRms > 0);
});

test("noise is continuous-time weighted and invariant to uneven resampling of the same waveform", () => {
  const triangle = (t) => {
    const force = 90 + 20 * (Math.floor(t) % 2 ? 1 - (t % 1) : t % 1);
    return [force, 20 + (force - 100) / 5];
  };
  const sparse = Array.from({ length: 7 }, (_, i) => [i, ...triangle(i)]);
  const uneven = [];
  for (let i = 0; i < 6; i++) {
    for (const fraction of [0, 0.01, 0.03, 0.31, 0.5, 0.9]) {
      const t = i + fraction;
      uneven.push([t, ...triangle(t)]);
    }
  }
  uneven.push([6, ...triangle(6)]);
  for (const rows of [sparse, uneven]) {
    const data = csv(rows);
    assert.equal(data.gaps, 0);
    const result = analyseProfile(data, { start: 0, end: 6, noiseWindow: 2, noiseStart: 1, noiseEnd: 5 });
    near(result.noiseThrustRms, 10 / Math.sqrt(3));
    near(result.noisePressureRms, 2 / Math.sqrt(3));
    near(result.noiseThrustPercent, 10 / Math.sqrt(3));
    near(result.noisePressurePercent, 10 / Math.sqrt(3));
  }
});

test("insufficient full-window support and zero-mean percentages do not invent noise estimates", () => {
  const short = analyseProfile(csv([[0, 0, 0], [0.05, 1, 1]]), { start: 0, end: 0.05, noiseWindow: 0.1 });
  assert.equal(short.noiseThrustRms, null);
  assert.deepEqual(short.curves.trend, []);
  assert.ok(short.warnings.some(({ key }) => key.includes("no complete moving window")));
  const zero = analyseProfile(csv([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), { start: 0, end: 2 });
  near(zero.noiseThrustRms, 0);
  assert.equal(zero.noiseThrustPercent, null);
  assert.equal(zero.noisePressurePercent, null);
});

test("event-relative and normalized mappings align shifted clocks without changing source-duration statistics", () => {
  const reference = csv([[0, 0, 0], [1, 100, 10], [2, 0, 0]], "ms");
  const candidate = csv([[10, 0, 0], [11, 50, 5], [12, 100, 10], [13, 50, 5], [14, 0, 0]], "us");
  const a = analyseProfile(reference, { start: 0, end: 2 });
  const b = analyseProfile(candidate, { start: 10, end: 14 });
  assert.deepEqual(profileMapping(a, "source"), { offset: 0, scale: 1 });
  assert.deepEqual(profileMapping(b, "ignition"), { offset: -10, scale: 1 });
  assert.deepEqual(profileMapping(b, "burnout"), { offset: -14, scale: 1 });
  assert.deepEqual(profileMapping(b, "normalized"), { offset: -250, scale: 25 });
  assert.equal(profileMapping({ start: null, end: null }, "ignition"), null);
  assert.equal(profileMapping({ start: null, end: null }, "burnout"), null);
  assert.equal(profileMapping({ start: 2, end: 1 }, "normalized"), null);
  assert.throws(() => profileMapping(a, "unknown"), UserError);
  const result = compareProfiles(reference, profileMapping(a, "normalized"), candidate, profileMapping(b, "normalized"), { start: 0, end: 100 });
  near(result.thrust.rmse, 0);
  near(result.pressure.rmse, 0);
  near(result.duration, 100);
  near(a.duration, 2);
  near(b.duration, 4);
  near(a.impulse, 100);
  near(b.impulse, 200);
  assert.equal(compareProfiles(reference, profileMapping(a, "source"), candidate, profileMapping(b, "source")), null);
});

test("difference bias, MAE, and RMSE use exact linear integrals rather than sample averages", () => {
  const reference = csv([0, 0.001, 0.01, 0.2, 0.6, 1, 1.4, 1.8, 2].map((t) => [t, 0, 0]));
  assert.equal(reference.gaps, 0);
  const candidate = csv([[0, -1, 4], [2, 3, -2]]);
  const result = compareProfiles(reference, { offset: 0, scale: 1 }, candidate, { offset: 0, scale: 1 });
  near(result.thrust.bias, 1);
  near(result.thrust.mae, 1.25);
  near(result.thrust.rmse, Math.sqrt(7 / 3));
  near(result.thrust.maxAbs, 3);
  near(result.pressure.bias, 1);
  near(result.pressure.mae, 5 / 3);
  near(result.pressure.rmse, 2);
  near(result.pressure.maxAbs, 4);
  near(result.coverage, 1);
});

test("differences use common valid support and mark missing intervals without extrapolation", () => {
  const reference = csv([[0, 100, 20], [0.1, 100, 20], [0.2, 100, 20], [2, 100, 20], [2.1, 100, 20], [2.2, 100, 20]]);
  const candidate = csv([[0, 110, 22], [1, 110, 22], [2.2, 110, 22]]);
  const mapping = { offset: 0, scale: 1 };
  const result = compareProfiles(reference, mapping, candidate, mapping);
  near(result.thrust.bias, 10);
  near(result.thrust.mae, 10);
  near(result.thrust.rmse, 10);
  near(result.pressure.rmse, 2);
  near(result.coverage, 0.4 / 2.2);
  assert.ok(result.points.some((point) => point.t === 2 && point.gapBefore));
  const gapOnly = csv([[0.5, 50, 2], [1, 50, 2], [1.5, 50, 2]]);
  assert.equal(compareProfiles(reference, mapping, gapOnly, mapping), null);
  assert.equal(compareProfiles(reference, mapping, candidate, { offset: 10, scale: 1 }), null);
  assert.equal(compareProfiles(reference, null, candidate, mapping), null);
  assert.throws(() => compareProfiles(reference, mapping, candidate, { offset: 0, scale: 0 }), UserError);
});

test("large curves stay within display budgets while retaining narrow extrema and gap breaks", () => {
  const rows = Array.from({ length: 12000 }, (_, i) => [i * 0.001, i === 4321 ? 1000 : 100, i === 6789 ? 200 : 20]);
  const data = csv(rows);
  const result = analyseProfile(data, { start: 0, end: data.end, noiseWindow: 0.02 });
  for (const points of Object.values(result.curves)) {
    assert.ok(points.length <= 2400, points.length);
    assert.ok(points.every((point) => Number.isFinite(point.t) && Number.isFinite(point.thrust) && Number.isFinite(point.pressure)));
  }
  assert.equal(Math.max(...result.curves.raw.map((point) => point.thrust)), 1000);
  assert.equal(Math.max(...result.curves.raw.map((point) => point.pressure)), 200);
  const zero = csv(rows.map(([t]) => [t, 0, 0]));
  const difference = compareProfiles(zero, { offset: 0, scale: 1 }, data, { offset: 0, scale: 1 }, { budget: 120 });
  assert.ok(difference.points.length <= 120);
  assert.equal(Math.max(...difference.points.map((point) => point.thrust)), 1000);
  assert.equal(Math.max(...difference.points.map((point) => point.pressure)), 200);
});
