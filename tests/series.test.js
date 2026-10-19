import test from "node:test";
import assert from "node:assert/strict";
import { parseCSV } from "../src/data.js";
import { analyseProfile } from "../src/profiles/model.js";
import { analyseSeries, SERIES_METRICS } from "../src/profiles/series-model.js";

const near = (actual, expected, epsilon = 1e-8) => assert.ok(
  actual !== null && Math.abs(actual - expected) <= epsilon, `${actual} ≠ ${expected}`,
);
function profile(id, force, { start = 0, duration = 2, rate = 50, unit = "s", massKg, pressure = force / 50 } = {}) {
  const count = Math.round(duration * rate), scale = { s: 1, ms: 1000, us: 1e6 }[unit];
  const text = `time_${unit};thrust;pressure\n` + Array.from({ length: count + 1 }, (_, i) =>
    `${(start + duration * i / count) * scale};${force};${pressure}`).join("\n");
  const data = parseCSV(text);
  return { id, data, stats: analyseProfile(data, { start: data.start, end: data.end, massKg }) };
}

test("series metrics weight each test equally across sample rates, source clocks and timestamp units", () => {
  const entries = [
    profile("a", 80, { rate: 20, unit: "ms", massKg: 0.1 }),
    profile("b", 100, { rate: 120, unit: "us", start: 10, massKg: 0.1 }),
    profile("c", 120, { rate: 50, unit: "s", start: 30, massKg: 0.1 }),
  ];
  const result = analyseSeries(entries);
  assert.equal(result.includedCount, 3);
  assert.equal(result.eligibleCount, 3);
  assert.deepEqual(result.eligibleIds, ["a", "b", "c"]);
  assert.deepEqual(result.excluded, []);
  near(result.metrics.impulse.mean, 200);
  near(result.metrics.impulse.sd, 40);
  near(result.metrics.impulse.cv, 20);
  near(result.metrics.impulse.min, 160);
  near(result.metrics.impulse.max, 240);
  near(result.metrics.impulse.median, 200);
  near(result.metrics.meanThrust.mean, 100);
  near(result.metrics.meanThrust.sd, 20);
  near(result.metrics.specificImpulse.mean, 200 / (0.1 * 9.80665));
  near(result.metrics.specificImpulse.sd, 40 / (0.1 * 9.80665));
  assert.equal(result.metrics.specificImpulse.n, 3);
  near(result.curve.start, 0);
  near(result.curve.end, 2);
  assert.equal(result.curve.count, 3);
  for (const point of result.curve.points) {
    near(point.thrust, 100);
    near(point.thrustSd, 20);
    near(point.pressure, 2);
    near(point.pressureSd, 0.4);
    near(point.thrustMin, 80);
    near(point.thrustMax, 120);
    assert.equal(point.n, 3);
  }
  const a = result.deviations.find(({ id }) => id === "a").metrics.impulse;
  near(a.value, 160); near(a.delta, -40); near(a.percent, -20); near(a.z, -1);
  assert.equal(a.outlier, false);
});

test("missing boundaries and incomplete telemetry are explicitly excluded while manual exclusions stay separate", () => {
  const valid = profile("valid", 100), hidden = { ...profile("unchecked", 500), included: false };
  const missing = profile("missing", 100);
  missing.stats.start = null;
  const data = parseCSV("time_s;thrust;pressure\n0;100;2\n0.1;100;2\n0.2;100;2\n2;100;2\n2.1;100;2\n2.2;100;2");
  const gap = { id: "gap", data, stats: analyseProfile(data, { start: 0, end: 2.2 }) };
  const result = analyseSeries([valid, hidden, missing, gap, { id: "unavailable" }]);
  assert.equal(result.includedCount, 4);
  assert.equal(result.eligibleCount, 1);
  assert.deepEqual(result.eligibleIds, ["valid"]);
  assert.deepEqual(result.excluded.map(({ id }) => id), ["missing", "gap", "unavailable"]);
  assert.match(result.excluded[0].reason.key, /valid ignition and burnout/);
  assert.match(result.excluded[1].reason.key, /Missing data/);
  assert.match(result.excluded[2].reason.key, /Raw measurements/);
  near(result.metrics.impulse.mean, 200);
  assert.equal(result.metrics.impulse.sd, null);
  assert.equal(result.metrics.impulse.cv, null);
  assert.equal(result.curve.points[0].thrustSd, null);
  assert.deepEqual(result.deviations.map(({ id }) => id), ["valid"]);
});

test("metric populations omit missing values without silently assigning mass or a zero Isp", () => {
  const a = profile("a", 100), b = profile("b", 120, { massKg: 0.1 });
  a.stats.noiseThrustRms = null;
  const result = analyseSeries([a, b]);
  assert.equal(result.metrics.specificImpulse.n, 1);
  near(result.metrics.specificImpulse.mean, 240 / (0.1 * 9.80665));
  assert.equal(result.metrics.specificImpulse.sd, null);
  assert.equal(result.metrics.specificImpulse.cv, null);
  assert.equal(result.metrics.noiseThrustRms.n, 1);
  assert.equal(result.deviations[0].metrics.specificImpulse.value, null);
  assert.equal(result.deviations[0].metrics.specificImpulse.delta, null);
  assert.equal(result.deviations[0].metrics.specificImpulse.percent, null);
  assert.equal(result.deviations[0].metrics.specificImpulse.z, null);
});

test("zero and near-zero means suppress unstable relative statistics, while identical tests have zero SD", () => {
  const zero = analyseSeries([profile("a", 0), profile("b", 0)]);
  near(zero.metrics.impulse.mean, 0);
  near(zero.metrics.impulse.sd, 0);
  assert.equal(zero.metrics.impulse.cv, null);
  assert.equal(zero.deviations[0].metrics.impulse.percent, null);
  assert.equal(zero.deviations[0].metrics.impulse.z, null);
  const a = profile("a", 1), b = profile("b", -1 + 1e-14);
  const cancelled = analyseSeries([a, b]);
  assert.equal(cancelled.metrics.meanThrust.cv, null);
  assert.equal(cancelled.deviations[0].metrics.meanThrust.percent, null);
  const tiny = analyseSeries([profile("a", 1e-15), profile("b", 2e-15)]);
  near(tiny.metrics.meanThrust.cv, 100 * Math.SQRT1_2 / 1.5);
  const identical = analyseSeries([profile("a", 100), profile("b", 100)]);
  near(identical.metrics.impulse.sd, 0);
  near(identical.metrics.impulse.cv, 0);
  assert.equal(identical.deviations[0].metrics.impulse.z, null);
});

test("Tukey 1.5 IQR flags use R7 quartiles only from five observations and never remove tests", () => {
  const entries = [10, 10, 10, 10, 10, 100].map((force, i) => profile(`test-${i}`, force));
  const result = analyseSeries(entries);
  assert.deepEqual(result.metrics.meanThrust.outlierIds, ["test-5"]);
  assert.equal(result.deviations[5].metrics.meanThrust.outlier, true);
  assert.equal(result.eligibleCount, 6);
  near(result.metrics.meanThrust.mean, 25);
  near(result.metrics.meanThrust.median, 10);
  const small = analyseSeries(entries.filter((_, i) => [0, 1, 2, 5].includes(i)));
  assert.deepEqual(small.metrics.meanThrust.outlierIds, []);
  const interpolated = analyseSeries([0, 10, 20, 30, 70].map((force, i) => profile(`${i}`, force)));
  assert.deepEqual(interpolated.metrics.meanThrust.outlierIds, ["4"]);
});

test("Tukey fences tolerate integral roundoff between repeated tests with unequal logger rates", () => {
  const entries = [20, 50, 60, 60, 60, 60, 60, 60, 700].map((rate, i) => profile(`repeat-${i}`, 100, { rate }));
  assert.ok(new Set(entries.map(({ stats }) => stats.impulse)).size > 1,
    "The fixture must contain real floating-point integration roundoff.");
  entries.push(profile("deviation", 150, { rate: 60 }));
  const result = analyseSeries(entries);
  assert.deepEqual(result.metrics.impulse.outlierIds, ["deviation"]);
  assert.equal(result.eligibleCount, 10);
  near(result.deviations.at(-1).metrics.impulse.value, 300);
});

test("constant tests with unequal logger rates have zero residual variation and unavailable zero-mean noise CV", () => {
  const entries = [20, 50, 60, 120, 333, 700].map((rate, i) => profile(`repeat-${i}`, 100, { rate }));
  const result = analyseSeries(entries);
  for (const key of ["noiseThrustRms", "noisePressureRms", "noiseThrustPercent"]) {
    assert.equal(result.metrics[key].n, entries.length);
    assert.equal(result.metrics[key].mean, 0);
    assert.equal(result.metrics[key].sd, 0);
    assert.equal(result.metrics[key].cv, null);
    assert.deepEqual(result.metrics[key].outlierIds, []);
    for (const test of result.deviations) {
      assert.equal(test.metrics[key].value, 0);
      assert.equal(test.metrics[key].delta, 0);
      assert.equal(test.metrics[key].percent, null);
      assert.equal(test.metrics[key].z, null);
    }
  }
});

test("missing analysis from invalid settings is distinguished from unavailable raw measurements", () => {
  const entry = profile("invalid-settings", 100);
  entry.stats = null;
  const result = analyseSeries([entry, { id: "unavailable" }]);
  assert.match(result.excluded[0].reason.key, /Correct invalid test settings/);
  assert.match(result.excluded[1].reason.key, /Raw measurements/);
});

test("sample SD remains stable for small series variation on a large numerical baseline", () => {
  const entries = [profile("a", 1), profile("b", 1), profile("c", 1)];
  for (let i = 0; i < entries.length; i++) entries[i].stats.impulse = 1e12 + i;
  const result = analyseSeries(entries);
  near(result.metrics.impulse.mean, 1e12 + 1);
  near(result.metrics.impulse.sd, 1);
  near(result.deviations[0].metrics.impulse.z, -1);
});

test("curve alignment and burn phase change the display without changing original scalar statistics", () => {
  const entries = [profile("a", 100), profile("b", 200, { start: 10, duration: 4, rate: 120 })];
  const ignition = analyseSeries(entries, { alignment: "ignition" });
  const burnout = analyseSeries(entries, { alignment: "burnout" });
  const normalized = analyseSeries(entries, { alignment: "normalized" });
  const source = analyseSeries(entries, { alignment: "source" });
  near(ignition.curve.start, 0); near(ignition.curve.end, 2);
  near(burnout.curve.start, -2); near(burnout.curve.end, 0);
  near(normalized.curve.start, 0); near(normalized.curve.end, 100);
  near(normalized.curve.points[0].t, 0);
  near(normalized.curve.points.at(-1).t, 100);
  assert.equal(source.curve, null);
  for (const result of [ignition, burnout, normalized, source]) {
    near(result.metrics.duration.mean, 3);
    near(result.metrics.duration.sd, Math.SQRT2);
    near(result.metrics.impulse.mean, 500);
    near(result.metrics.impulse.sd, Math.sqrt(180000));
  }
  for (const point of normalized.curve.points) {
    near(point.thrust, 150);
    near(point.thrustSd, Math.sqrt(5000));
  }
});

test("large-clock normalization includes both exact burn-phase endpoints", () => {
  const entries = [profile("a", 100, { start: 121234.123, duration: 2.3 }), profile("b", 100, { start: 381234.567, duration: 3.7 })];
  const result = analyseSeries(entries, { alignment: "normalized" });
  assert.equal(result.curve.points[0].t, 0);
  assert.equal(result.curve.points.at(-1).t, 100);
  for (const point of result.curve.points) near(point.thrust, 100);
});

test("bounded display curves preserve isolated source extrema and do not change exact scalar results", () => {
  const count = 10001;
  const text = "time_ms;thrust;pressure\n" + Array.from({ length: count }, (_, i) =>
    `${i};${i === 4321 ? 1000 : 100};${i === 6789 ? 100 : 2}`).join("\n");
  const data = parseCSV(text);
  const a = { id: "spike", data, stats: analyseProfile(data, { start: 0, end: 10 }) };
  const b = profile("baseline", 100, { duration: 10, rate: 20 });
  const small = analyseSeries([a, b], { budget: 120 });
  const large = analyseSeries([a, b], { budget: 50000 });
  assert.ok(small.curve.points.length <= 120, small.curve.points.length);
  assert.ok(large.curve.points.length <= 2400, large.curve.points.length);
  near(Math.max(...small.curve.points.map(({ thrust }) => thrust)), 550);
  near(Math.max(...small.curve.points.map(({ pressure }) => pressure)), 51);
  near(Math.max(...small.curve.points.map(({ thrustMax }) => thrustMax)), 1000);
  near(Math.max(...small.curve.points.map(({ pressureMax }) => pressureMax)), 100);
  assert.deepEqual(small.metrics, large.metrics);
  assert.deepEqual(small.deviations, large.deviations);
});

test("empty and unavailable metric populations are explicit and serializable", () => {
  const result = analyseSeries([]);
  assert.equal(result.includedCount, 0);
  assert.equal(result.eligibleCount, 0);
  assert.equal(result.curve, null);
  assert.deepEqual(Object.keys(result.metrics), SERIES_METRICS);
  for (const summary of Object.values(result.metrics)) {
    assert.equal(summary.n, 0);
    for (const key of ["mean", "sd", "cv", "min", "max", "median"]) assert.equal(summary[key], null);
    assert.deepEqual(summary.outlierIds, []);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
