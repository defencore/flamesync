import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCSV,
  sampleAt,
  logPositionAt,
  dataTimeAt,
  cumulativeAt,
  formatValue,
} from "../src/data.js";
import {
  displayThrust,
  displayPressure,
  thrustFactor,
  pressureFactor,
  sourceTimestamp,
} from "../src/units.js";
import { detectBurnInterval } from "../src/measurement.js";

const close = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.max(1e-10, Math.abs(expected) * 1e-12),
    `${actual} vs ${expected}`,
  );

test("milliseconds and microseconds preserve the same absolute logger clock and burn interval", () => {
  const milliseconds = parseCSV(
    "time_ms;thrust;pressure\n100;0;0\n200;100;2\n300;0;0",
  );
  const microseconds = parseCSV(
    "time_us;thrust;pressure\n100000;0;0\n200000;100;2\n300000;0;0",
  );
  for (let i = 0; i < 3; i++)
    close(milliseconds.points[i].t, microseconds.points[i].t);
  close(milliseconds.impulse, microseconds.impulse);
  close(
    detectBurnInterval(milliseconds).start,
    detectBurnInterval(microseconds).start,
  );
  assert.equal(microseconds.sourceUnits.time, "us");
  assert.equal(sourceTimestamp(0.15, "us"), "150000 µs");
  assert.equal(sourceTimestamp(0.15, "ms"), "150 ms");
});

test("time units are explicit: generic time requires selection, and unit overrides are honored", () => {
  assert.throws(
    () => parseCSV("time;thrust;pressure\n0;1;1\n1000;2;2"),
    /no unit/,
  );
  close(
    parseCSV("time;thrust;pressure\n0;1;1\n1000;2;2", { timeUnit: "us" }).end,
    0.001,
  );
  close(
    parseCSV("time_ms;thrust;pressure\n0;1;1\n1000;2;2", { timeUnit: "us" })
      .end,
    0.001,
  );
  close(parseCSV("time_s;thrust;pressure\n0;1;1\n0.1;2;2").end, 0.1);
  assert.throws(
    () => parseCSV("time_ms;time_us;thrust;pressure\n0;0;1;1\n1;1000;2;2"),
    /one of/,
  );
  assert.throws(
    () =>
      parseCSV("time_ms;thrust;pressure\n0;1;1\n1;2;2", {
        timeUnit: "minutes",
      }),
    /Unsupported unit/,
  );
});

test("input and output conversions agree for force, pressure, peaks, and integrated impulse", () => {
  const data = parseCSV("time_ms;thrust;pressure\n0;0;0\n100;1;2\n200;0;0", {
    thrustUnit: "kgf",
    pressureUnit: "MPa",
  });
  close(data.peakThrust, 9.80665);
  close(data.peakPressure, 20);
  close(data.impulse, 0.980665);
  close(displayThrust(data.peakThrust, "kgf"), 1);
  close(displayThrust(data.impulse, "kgf"), 0.1);
  close(displayThrust(sampleAt(data, 0.05).thrust, "gf"), 500);
  close(displayPressure(sampleAt(data, 0.05).pressure, "kPa"), 1000);
  close(displayPressure(data.peakPressure, "MPa"), 2);
  for (const unit of ["N", "kN", "kgf", "gf", "lbf"])
    close(displayThrust(-123.456 * thrustFactor(unit), unit), -123.456);
  for (const unit of ["Pa", "kPa", "MPa", "bar", "psi", "atm"])
    close(displayPressure(-123.456 * pressureFactor(unit), unit), -123.456);
  close(displayPressure(1.01325, "atm"), 1);
  close(displayThrust(4.4482216152605, "lbf"), 1);
  close(pressureFactor("psi") * 100000, 6894.757293168361);
  assert.throws(() => thrustFactor("kg"), /Unsupported unit/);
  assert.throws(() => pressureFactor("C"), /Unsupported unit/);
  assert.notEqual(formatValue(displayThrust(0.1, "kN")), "0.0");
});

test("CSV rows retain physical line numbers, interpolate independently of camera rate, and respect offset", () => {
  const data = parseCSV(
    "# logger\ntime_us;thrust;pressure\n\n1000000;0;0\n# comment\n1020000;10;2\n1040000;0;0",
  );
  const exact = logPositionAt(data, 1.02);
  assert.equal(exact.phase, "exact");
  assert.equal(exact.first.line, 6);
  const interpolated = logPositionAt(data, dataTimeAt(3.01, 2));
  assert.equal(interpolated.phase, "interpolated");
  assert.equal(interpolated.first.line, 4);
  assert.equal(interpolated.second.line, 6);
  close(interpolated.fraction, 0.5);
  assert.equal(logPositionAt(data, 0.9).phase, "before");
  assert.equal(logPositionAt(data, 1.1).phase, "after");
  const fast = parseCSV(
    "time_us;thrust;pressure\n" +
      Array.from({ length: 101 }, (_, i) => `${i * 1000};${i};0`).join("\n"),
  );
  const frame = logPositionAt(fast, 1 / 30);
  assert.equal(frame.first.line, 35);
  assert.equal(frame.second.line, 36);
  close(frame.fraction, 1 / 3);
});

test("slow acquisition remains continuous while exceptional gaps are disclosed", () => {
  const slow = parseCSV(
    "time_s;thrust;pressure\n0;0;0\n1;10;2\n2;10;2\n3;0;0\n4;0;0",
  );
  assert.equal(slow.gaps, 0);
  close(sampleAt(slow, 0.5).thrust, 5);
  close(slow.impulse, 20);
  const gaps = parseCSV(
    "time_s;thrust;pressure\n0;0;0\n1;10;2\n2;10;2\n10;0;0\n11;0;0",
  );
  assert.equal(gaps.gaps, 1);
  assert.equal(logPositionAt(gaps, 5).phase, "gap");
  assert.equal(sampleAt(gaps, 5), null);
  assert.equal(cumulativeAt(gaps, 5).phase, "gap");
});
