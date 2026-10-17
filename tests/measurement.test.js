import test from "node:test";
import { formatMessage } from "../src/messages.js";
import assert from "node:assert/strict";
import { parseCSV } from "../src/data.js";
import {
  detectBurnInterval,
  intervalStats,
  adjacentTelemetryTime,
} from "../src/measurement.js";
import { frameInfoAt, selectedFrameRange } from "../src/timing.js";
const log = (rows) =>
  parseCSV(
    "time_ms;thrust;pressure\n" + rows.map((row) => row.join(";")).join("\n"),
  );

test("burn duration uses interpolated first rise and final decay, not log length", () => {
  const data = log([
    [100, 0, 0],
    [200, 100, 2],
    [300, 80, 2],
    [400, 0, 0],
    [500, 0, 0],
  ]);
  const detected = detectBurnInterval(data, 5);
  assert.ok(Math.abs(detected.start - 0.105) < 1e-10);
  assert.ok(Math.abs(detected.end - 0.39375) < 1e-10);
  assert.ok(
    Math.abs(
      intervalStats(data, detected.start, detected.end).csvDuration - 0.28875,
    ) < 1e-10,
  );
  assert.equal(detected.periods, 1);
});
test("missing rise, missing decay, and all-zero logs do not invent complete burn boundaries", () => {
  assert.equal(
    detectBurnInterval(
      log([
        [0, 10, 0],
        [100, 5, 0],
        [200, 0, 0],
      ]),
    ).start,
    null,
  );
  assert.equal(
    detectBurnInterval(
      log([
        [0, 0, 0],
        [100, 5, 0],
        [200, 10, 0],
      ]),
    ).end,
    null,
  );
  const zero = detectBurnInterval(
    log([
      [0, 0, 0],
      [100, 0, 0],
    ]),
  );
  assert.equal(zero.start, null);
  assert.equal(zero.end, null);
});
test("crossings inside data gaps are unavailable, and measured elapsed time discloses internal gaps", () => {
  const data = log([
    [0, 0, 0],
    [1000, 100, 0],
    [1100, 100, 0],
    [1200, 0, 0],
  ]);
  assert.equal(detectBurnInterval(data).start, null);
  assert.equal(intervalStats(data, 0, 1.2).gaps, 1);
});
test("multiple pulses measure first-to-final elapsed interval including the pause", () => {
  const data = log([
    [0, 0, 0],
    [100, 100, 0],
    [200, 0, 0],
    [300, 100, 0],
    [400, 0, 0],
  ]);
  const burn = detectBurnInterval(data);
  assert.equal(burn.periods, 2);
  assert.match(
    burn.warnings.map((item) => formatMessage(item.key, item.values)).join(" "),
    /including pauses/,
  );
  assert.ok(Math.abs(burn.end - 0.395) < 1e-10);
});
test("CSV duration stays original when the corresponding video interval is stretched", () => {
  const data = log([
    [0, 0, 0],
    [100, 10, 0],
    [200, 0, 0],
  ]);
  const result = intervalStats(data, 0.025, 0.175, 4);
  assert.ok(Math.abs(result.csvDuration - 0.15) < 1e-10);
  assert.ok(Math.abs(result.videoDuration - 0.6) < 1e-10);
  for (const [a, b] of [
    [-0.1, 0.1],
    [0.1, 0.3],
    [0.15, 0.05],
    [0.1, 0.1],
    [NaN, 0.15],
  ])
    assert.throws(() => intervalStats(data, a, b));
  for (const threshold of [0, 100, NaN])
    assert.throws(() => detectBurnInterval(data, threshold));
});
test("measurement keyboard stepping follows uneven logger sample times", () => {
  const data = log([
    [0, 0, 0],
    [10, 10, 0],
    [33, 0, 0],
    [80, 1, 0],
  ]);
  assert.equal(adjacentTelemetryTime(data, 0.01, 1), 0.033);
  assert.equal(adjacentTelemetryTime(data, 0.025, -1), 0.01);
  assert.equal(adjacentTelemetryTime(data, 0, -1), 0);
});
test("source frame information is one-based and uses actual VFR timestamps", () => {
  const frames = new Float64Array([0, 0.008, 0.025, 0.058, 0.1]);
  const frame = frameInfoAt(frames, 0.04, 0.12);
  assert.equal(frame.number, 3);
  assert.equal(frame.timestamp, 0.025);
  assert.ok(Math.abs(frame.duration - 0.033) < 1e-10);
  assert.deepEqual(selectedFrameRange(frames, 0.01, 0.1, 0.12), {
    first: 2,
    last: 4,
    count: 3,
  });
  assert.equal(selectedFrameRange(frames, 0.12, 0.15, 0.12), null);
  assert.equal(frameInfoAt(new Float64Array(), 0, 0), null);
});
