import test from "node:test";
import assert from "node:assert/strict";
import { parseCSV, sampleAt, cumulativeAt, logPositionAt, chartPoints } from "../src/data.js";
import { csvTable, inspectCSV } from "../src/csv-format.js";
import { detectBurnInterval } from "../src/measurement.js";
import { analyseProfile, compareProfiles } from "../src/profiles/model.js";

const near = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Number.isFinite(actual), `Expected a finite value, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};

test("negative baseline zero crossings have identical cumulative and profile impulse", () => {
  const data = parseCSV("time_s;thrust;pressure\n0;-10;0\n1;10;0");
  near(data.impulse, 2.5);
  near(sampleAt(data, .75).impulse, .625);
  near(analyseProfile(data, { start: 0, end: 1 }).impulse, data.impulse);
  const huge = parseCSV("time_s;thrust;pressure\n0;1e308;0\n1;1e308;0");
  near(huge.impulse / 1e308, 1);
});

test("headerless decimal commas do not override a semicolon column separator", () => {
  const data = parseCSV("0,0;1,0\n0,1;2,0", { hasHeader: false, timeUnit: "s", columns: { thrustTime: 0, thrust: 1, pressureTime: null, pressure: null } });
  near(data.end, .1);
  near(data.impulse, .15);
});
const columns = { thrustTime: 0, thrust: 1, pressureTime: 2, pressure: 3, markerMode: "none", active: null, start: null, end: null };
const mapped = (text, options = {}) => parseCSV(text, {
  timeUnit: "s", pressureTimeUnit: "s", thrustUnit: "N", pressureUnit: "bar", columns, ...options,
});
const events = (body, mode = "active") => mapped(`t;force;pressure_t;pressure;active;start;end\n${body}`, {
  columns: { ...columns, markerMode: mode, active: 4, start: 5, end: 6 },
});

test("explicit column indices distinguish duplicate headers and ignored textual columns", () => {
  const data = mapped("note;value;clock;value;clock\nfirst;10;1000;2;1500000\nsecond;20;2000;4;2500000", {
    timeUnit: "ms", pressureTimeUnit: "us",
    columns: { ...columns, thrustTime: 2, thrust: 1, pressureTime: 4, pressure: 3 },
  });
  near(sampleAt(data, 1.5).thrust, 15);
  near(sampleAt(data, 1.5).pressure, 2);
  assert.equal(sampleAt(data, 1).pressure, null);
  assert.deepEqual(data.points.map(({ line }) => line), [2, 3]);
});

test("quoted delimiters, escaped quotes and multiline ignored fields retain physical row numbers", () => {
  const text = '# metadata\nt,f,p,n\n0,0,1,"comma, quoted ""yes"""\n0.1,10,2,"line one\nline two"\n// comment\n0.2,0,3,ok';
  const table = csvTable(text);
  assert.equal(table.rows[0].values[3], 'comma, quoted "yes"');
  assert.equal(table.rows[1].values[3], "line one\nline two");
  const data = mapped(text, { columns: { ...columns, pressureTime: null, pressure: 2 } });
  assert.deepEqual(data.points.map(({ line }) => line), [3, 4, 7]);
  const position = logPositionAt(data, 0.15);
  assert.equal(position.first.line, 4);
  assert.equal(position.second.line, 7);
});

test("comments may contain unmatched quote characters without changing CSV records", () => {
  const data = parseCSV('# operator says "start\ntime_s;thrust;pressure\n0;0;1\n0.1;10;2\n// "end\n0.2;0;3');
  assert.deepEqual(data.points.map(({ line }) => line), [3, 4, 6]);
});

test("unclosed quoted fields fail with the original physical line", () => {
  assert.throws(() => mapped('t;f;p_t;p;note\n0;0;0;1;ok\n1;1;1;2;"unfinished'), /Line 3/);
});

test("malformed quote placement never silently changes a numerical reading", () => {
  for (const force of ['"1"2', '1"2"'])
    assert.throws(() => parseCSV(`time_s;thrust;pressure\n0;${force};0\n1;0;0`), /Line 2/);
  const valid = parseCSV('time_s;thrust;pressure\n0; "12" ;0\n1;0;0');
  assert.equal(valid.points[0].thrust, 12);
});

test("headerless imports include the first sample and support column mapping", () => {
  const data = mapped("0;2;0;1\n0.2;4;0.2;3", { hasHeader: false });
  assert.equal(data.points.length, 2);
  assert.equal(data.points[0].line, 1);
  near(data.impulse, 0.6);
  assert.deepEqual(inspectCSV("0;2;0;1\n0.2;4;0.2;3", { hasHeader: false }).headers,
    ["Column 1", "Column 2", "Column 3", "Column 4"]);
});

test("separate auto-detected microsecond and millisecond clocks preserve pressure spikes", () => {
  const data = mapped("time_us;force;time_ms;pressure\n0;0;0;0\n250000;4;100;0\n500000;8;200;100\n750000;4;300;0\n1000000;0;400;0", {
    timeUnit: "auto", pressureTimeUnit: "auto",
  });
  near(sampleAt(data, 0.2).thrust, 3.2);
  near(sampleAt(data, 0.2).pressure, 100);
  assert.equal(sampleAt(data, 0.7).pressure, null);
  near(data.impulse, 4);
  const stats = analyseProfile(data, { start: 0, end: 1 });
  near(stats.impulse, 4);
  near(stats.peakPressure, 100);
  near(stats.meanPressure, 25);
  near(stats.pressureCoverage, 0.4);
  assert.equal(Math.max(...chartPoints(data).map(({ pressure }) => pressure ?? -Infinity)), 100);
});

test("a pressure clock extending beyond thrust remains available without force extrapolation", () => {
  const data = mapped("force_t;force;pressure_t;pressure\n0.2;0;0;2\n0.4;4;0.4;2\n0.6;0;0.8;2");
  assert.equal(data.overallStart, 0);
  assert.equal(data.overallEnd, 0.8);
  assert.equal(sampleAt(data, 0).thrust, null);
  assert.equal(sampleAt(data, 0).pressure, 2);
  assert.equal(sampleAt(data, 0.7).thrust, null);
  assert.equal(sampleAt(data, 0.7).pressure, 2);
  near(cumulativeAt(data, 0.7).impulse, 0.8);
  assert.equal(cumulativeAt(data, 0.7).phase, "live");
  assert.equal(cumulativeAt(data, 0.8).phase, "complete");
  assert.equal(sampleAt(data, -0.1), null);
  assert.equal(sampleAt(data, 0.9), null);
});

test("a gap only in pressure never suppresses force or integrates missing pressure", () => {
  const times = [0, 0.1, 0.2, 0.5, 0.8, 1.1, 1.4, 1.7, 2, 2.1, 2.2];
  const pressure = new Map([[0, 1], [0.1, 2], [0.2, 3], [2, 20], [2.1, 21], [2.2, 22]]);
  const data = mapped("t;f;p_t;p\n" + times.map((time) => `${time};10;${pressure.has(time) ? time : ""};${pressure.get(time) ?? ""}`).join("\n"), { allowSparse: true });
  assert.equal(data.gaps, 0);
  assert.equal(data.channels.pressure.gaps, 1);
  assert.equal(sampleAt(data, 1).thrust, 10);
  assert.equal(sampleAt(data, 1).pressure, null);
  assert.equal(cumulativeAt(data, 1).peakPressure, 3);
  assert.equal(logPositionAt(data, 1, "pressure").phase, "gap");
  const stats = analyseProfile(data, { start: 0, end: 2.2 });
  near(stats.coverage, 1);
  near(stats.pressureCoverage, 0.4 / 2.2);
  near(stats.impulse, 22);
  near(stats.meanPressure, 11.5);
});

test("pressure can advance while force is in a gap, with no future peak leakage", () => {
  const rows = [
    [0, 0, 0, 0], [0.1, 10, 0.2, 2], [0.2, 0, 0.4, 4],
    [2, 100, 0.6, 6], [2.1, 0, 0.8, 8], [2.2, 0, 1, 10],
  ];
  const data = mapped("t;f;p_t;p\n" + rows.map((row) => row.join(";")).join("\n"));
  assert.equal(sampleAt(data, 0.8).thrust, null);
  assert.equal(sampleAt(data, 0.8).pressure, 8);
  assert.equal(cumulativeAt(data, 0.8).peakThrust, 10);
  assert.equal(cumulativeAt(data, 0.8).peakPressure, 8);
  near(cumulativeAt(data, 0.8).impulse, 1);
});

test("shared-clock sparse pressure samples interpolate independently and preserve actual zero", () => {
  const data = mapped("t;f;p\n0;0;0\n0.1;5;\n0.2;10;2\n0.3;0;", {
    allowSparse: true, columns: { ...columns, pressureTime: null, pressure: 2 },
  });
  near(sampleAt(data, 0.1).pressure, 1);
  assert.equal(sampleAt(data, 0).pressure, 0);
  assert.equal(sampleAt(data, 0.3).pressure, null);
  assert.deepEqual(data.pressurePoints.map(({ line }) => line), [2, 4]);
});

test("absent pressure is unavailable rather than a fabricated zero measurement", () => {
  const data = mapped("t;f;ignored\n0;0;text\n0.1;10;text", {
    columns: { ...columns, pressure: null, pressureTime: null },
  });
  assert.equal(sampleAt(data, 0.05).pressure, null);
  assert.equal(data.peakPressure, null);
  assert.equal(cumulativeAt(data, 0.05).peakPressure, null);
  const stats = analyseProfile(data, { start: 0, end: 0.1 });
  assert.equal(stats.meanPressure, null);
  assert.equal(stats.peakPressure, null);
});

test("sparse value cells still require a valid timestamp when a value is present", () => {
  assert.throws(() => mapped("t;f;p_t;p\n0;1;0;2\n0.1;1;;3", { allowSparse: true }), /Line 3/);
  assert.throws(() => mapped("t;f;p_t;p\n0;1;0;2\n0.1;1;bad;", { allowSparse: true }), /Line 3/);
});

test("a single pressure reading exists only at its timestamp and supplies no invented interval", () => {
  const data = mapped("t;f;p_t;p\n0;0;;\n0.1;10;0.05;0\n0.2;0;;", { allowSparse: true });
  assert.equal(sampleAt(data, 0.05).pressure, 0);
  assert.equal(sampleAt(data, 0.04).pressure, null);
  assert.equal(sampleAt(data, 0.06).pressure, null);
  const stats = analyseProfile(data, { start: 0, end: 0.2 });
  assert.equal(stats.meanPressure, null);
  assert.equal(stats.pressureCoverage, 0);
  assert.equal(stats.noisePressureRms, null);
});

test("independent native pressure statistics and differences are unaffected by force clock density", () => {
  const pressure = [[0, 0], [0.1, 2], [0.2, 0], [0.3, 0], [0.4, 0]];
  const sparse = mapped("t;f;p_t;p\n" + pressure.map(([time, value], index) => `${index === 0 ? 0 : index === 4 ? 0.4 : ""};${index === 0 || index === 4 ? 10 : ""};${time};${value}`).join("\n"), { allowSparse: true });
  const dense = mapped("t;f;p_t;p\n" + pressure.map(([time, value]) => `${time};10;${time};${value}`).join("\n"));
  const a = analyseProfile(sparse, { start: 0, end: 0.4 });
  const b = analyseProfile(dense, { start: 0, end: 0.4 });
  near(a.meanPressure, 0.5);
  near(a.noisePressureRms, b.noisePressureRms);
  const comparison = compareProfiles(sparse, { offset: 0, scale: 1 }, dense, { offset: 0, scale: 1 });
  near(comparison.pressure.rmse, 0);
  near(comparison.thrust.rmse, 0);
});

test("active-state indicators use exact logger times and override a different threshold crossing", () => {
  const data = events("0;0;0;0;0;;\n0.1;100;0.1;1;0;;\n0.2;100;0.2;1;1;;\n0.3;100;0.3;1;1;;\n0.4;100;0.4;1;0;;\n0.5;0;0.5;0;0;;");
  const detected = detectBurnInterval(data);
  assert.equal(detected.start, 0.2);
  assert.equal(detected.end, 0.4);
  assert.equal(detected.periods, 1);
  assert.equal(data.ignition, 0.2);
});

test("blank active cells do not create false edges and true/false states are supported", () => {
  const data = events("0;0;0;0;false;;\n0.1;10;0.1;1;true;;\n0.2;10;0.2;1;;;\n0.3;0;0.3;0;false;;");
  assert.equal(data.events.start, 0.1);
  assert.equal(data.events.end, 0.3);
});

test("an unfinished active interval keeps B unset instead of borrowing a threshold decay", () => {
  const data = events("0;0;0;0;0;;\n0.1;10;0.1;1;1;;\n0.2;0;0.2;0;1;;");
  assert.equal(detectBurnInterval(data).end, null);
  assert.ok(detectBurnInterval(data).warnings.some(({ key }) => key.includes("No burnout indicator")));
});

test("multiple active intervals span first ignition through the final completed burnout", () => {
  const data = events("0;0;0;0;0;;\n0.1;10;0.1;1;1;;\n0.2;0;0.2;0;0;;\n0.3;10;0.3;1;1;;\n0.4;0;0.4;0;0;;");
  assert.equal(data.events.start, 0.1);
  assert.equal(data.events.end, 0.4);
  assert.equal(detectBurnInterval(data).periods, 2);
});

test("separate ignition and burnout pulses use rising edges and permit either missing endpoint", () => {
  const data = events("0;0;0;0;;0;0\n0.1;10;0.1;1;;1;0\n0.2;10;0.2;1;;1;0\n0.3;0;0.3;0;;0;1", "events");
  assert.equal(data.events.start, 0.1);
  assert.equal(data.events.end, 0.3);
  assert.equal(data.events.periods, 1);
  const onlyEnd = events("0;0;0;0;;0;0\n0.1;10;0.1;1;;0;0\n0.2;0;0.2;0;;0;1", "events");
  assert.equal(detectBurnInterval(onlyEnd).start, null);
  assert.equal(detectBurnInterval(onlyEnd).end, 0.2);
});

test("an unmatched final ignition pulse never reuses an earlier burnout", () => {
  const data = events("0;0;0;0;;0;0\n0.1;10;0.1;1;;1;0\n0.2;0;0.2;0;;0;1\n0.3;10;0.3;1;;1;0\n0.4;10;0.4;1;;0;0", "events");
  assert.equal(data.events.start, 0.1);
  assert.equal(data.events.end, null);
  assert.equal(data.events.periods, 2);
});

test("invalid indicator values and burnout before ignition fail clearly", () => {
  assert.throws(() => events("0;0;0;0;0;;\n0.1;10;0.1;1;2;;"), /indicators must be/);
  assert.throws(() => events("0;0;0;0;;0;1\n0.1;10;0.1;1;;1;0", "events"), /Burnout must follow ignition/);
});

test("indicators keep their selected thrust clock when pressure uses a different time unit", () => {
  const data = mapped("t;force;pressure_t;pressure;active\n0;0;0;0;0\n100000;10;100;1;1\n200000;0;200;0;0", {
    timeUnit: "us", pressureTimeUnit: "ms", columns: { ...columns, markerMode: "active", active: 4 },
  });
  near(detectBurnInterval(data).start, 0.1);
  near(detectBurnInterval(data).end, 0.2);
});

test("indicator-only rows use thrust timestamps but cannot place events outside measured force support", () => {
  assert.throws(() => events("0;0;0;0;0;;\n0.1;10;0.1;1;1;;\n0.2;;0.2;0;0;;", "active"), /finite numeric/);
  assert.throws(() => mapped("t;f;p_t;p;active\n0;0;0;0;0\n0.1;10;0.1;1;1\n0.2;;0.2;0;0", {
    allowSparse: true, columns: { ...columns, markerMode: "active", active: 4 },
  }), /inside the thrust time range/);
});

test("mapping rejects invalid indices, time/value collisions and ambiguous event columns", () => {
  const text = "t;f;p_t;p\n0;0;0;0\n0.1;1;0.1;1";
  for (const bad of [{ thrustTime: -1 }, { thrust: 4 }, { thrust: 0 }, { pressure: 2 }, { pressureTime: 1.5 }, { markerMode: "active", active: 8 }, { markerMode: "events", start: 1, end: 1 }]) {
    assert.throws(() => mapped(text, { columns: { ...columns, ...bad } }));
  }
});

test("units, nonfinite values, negative clocks and duplicate native timestamps are rejected", () => {
  const text = "t;f;p_t;p\n0;0;0;0\n0.1;1;0.1;1";
  for (const invalid of [{ timeUnit: "minutes" }, { pressureTimeUnit: "nanoseconds" }, { thrustUnit: "mass" }, { pressureUnit: "temperature" }])
    assert.throws(() => mapped(text, invalid), /Unsupported unit/);
  for (const row of ["0.1;NaN;0.1;1", "0.1;1;Infinity;1", "0.1;1;-0.1;1", "0.1;1;0;1"])
    assert.throws(() => mapped(`t;f;p_t;p\n0;0;0;0\n${row}`), /Line 3/);
});

test("conversion and integrated-value overflow cannot enter accepted telemetry", () => {
  assert.throws(() => mapped("t;f;p_t;p\n0;0;0;0\n0.1;1e308;0.1;1", { thrustUnit: "kN" }), /numeric range/);
  assert.throws(() => mapped("t;f;p_t;p\n0;1e308;0;0\n2;1e308;2;1"), /numeric range/);
});
