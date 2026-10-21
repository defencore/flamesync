import test from "node:test";
import assert from "node:assert/strict";
import {
  mediaSeekTime,
  adjacentFrameTime,
  frameInfoAt,
  selectedFrameRange,
  summarizeFrameTiming,
} from "../src/timing.js";

const rates = [
  ["29.97", 30000 / 1001],
  ["59.94", 60000 / 1001],
  ["60", 60],
  ["120", 120],
];

const mediaClock = (time) => Math.round(time * 1e6) / 1e6;

for (const [label, fps] of rates) {
  const timestamps = Float64Array.from(
    { length: 361 },
    (_, index) => index / fps,
  );
  const end = timestamps.at(-1) + 1 / fps;

  test(`${label} FPS: repeated frame stepping survives the browser's microsecond clock`, () => {
    let position = mediaClock(timestamps[0]);
    for (let index = 1; index < timestamps.length; index++) {
      const next = adjacentFrameTime(timestamps, position, 1);
      assert.equal(
        next,
        timestamps[index],
        `Next must reach frame ${index + 1}`,
      );
      position = mediaClock(next);
      const displayed = frameInfoAt(timestamps, position, end);
      assert.equal(
        displayed.number,
        index + 1,
        `Display must identify frame ${index + 1}`,
      );
      assert.equal(displayed.timestamp, next);
    }
    assert.equal(adjacentFrameTime(timestamps, position, 1), timestamps.at(-1));

    for (let index = timestamps.length - 2; index >= 0; index--) {
      const previous = adjacentFrameTime(timestamps, position, -1);
      assert.equal(
        previous,
        timestamps[index],
        `Back must reach frame ${index + 1}`,
      );
      position = mediaClock(previous);
      assert.equal(frameInfoAt(timestamps, position, end).number, index + 1);
    }
    assert.equal(adjacentFrameTime(timestamps, position, -1), timestamps[0]);
  });

  test(`${label} FPS: arbitrary times still select their containing frame`, () => {
    for (let index = 1; index < timestamps.length - 1; index++) {
      const start = timestamps[index];
      const finish = timestamps[index + 1];
      // These positions are well inside a frame, independent of clock precision.
      for (const fraction of [0.1, 0.5, 0.9]) {
        const position = start + (finish - start) * fraction;
        assert.equal(frameInfoAt(timestamps, position, end).number, index + 1);
        assert.equal(adjacentFrameTime(timestamps, position, 1), finish);
        assert.equal(
          adjacentFrameTime(timestamps, position, -1),
          timestamps[index - 1],
        );
      }
    }
  });

  test(`${label} FPS: an exact Out boundary remains exclusive`, () => {
    const first = 10;
    const last = 39;
    const out = timestamps[last + 1];
    assert.equal(frameInfoAt(timestamps, out, end).number, last + 2);
    assert.deepEqual(
      selectedFrameRange(timestamps, timestamps[first], out, end),
      {
        first: first + 1,
        last: last + 1,
        count: last - first + 1,
      },
    );
    assert.deepEqual(
      selectedFrameRange(
        timestamps,
        timestamps[first],
        timestamps[first + 1],
        end,
      ),
      { first: first + 1, last: first + 1, count: 1 },
    );
  });
}

test("native seeks stay inside fractional frames while preserving their logical PTS", () => {
  for (const [, fps] of rates) {
    const times = Float64Array.from({ length: 80 }, (_, i) => i / fps);
    const end = 80 / fps;
    for (let i = 0; i < times.length; i++) {
      const mediaTime = mediaSeekTime(times, times[i], end);
      const truncated = Math.floor(mediaTime * 1e6) / 1e6;
      assert.ok(
        truncated >= times[i],
        `Browser truncation must not fall back from frame ${i + 1} at ${fps}fps`,
      );
      assert.ok(mediaTime < (times[i + 1] ?? end));
      assert.equal(frameInfoAt(times, mediaTime, end).timestamp, times[i]);
    }
  }
});
test("interior media seeks retain arbitrary positions and stay bounded for short final frames", () => {
  const times = new Float64Array([0, 0.1, 0.3]);
  assert.equal(mediaSeekTime(times, 0.15, 0.5), 0.15);
  const last = mediaSeekTime(times, 0.3, 0.300001);
  assert.ok(last > 0.3 && last < 0.300001);
  assert.equal(mediaSeekTime(new Float64Array(), 0.15, 0.5), 0.15);
});

test("a one-frame recording derives its rate from the frame's actual duration", () => {
  const timing = summarizeFrameTiming(new Float64Array([0.02]), 0.045, 1000);
  assert.equal(timing.frameCount, 1);
  assert.equal(timing.fps, 40);
  assert.equal(timing.minFps, 40);
  assert.equal(timing.maxFps, 40);
  assert.equal(timing.variable, false);
  assert.equal(timing.start, 0.02);
  assert.equal(timing.end, 0.045);
});

test("an invalid frame index cannot advertise plausible FPS or propagate a broken clock", () => {
  for (const [values, end, resolution] of [
    [[], 1, 1000],
    [[0, 0.02, NaN], 1, 1000],
    [[0, Infinity], 1, 1000],
    [[-0.01, 0], 1, 1000],
    [[0, 0.02, 0.01], 1, 1000],
    [[0, 0.01, 0.01], 1, 1000],
    [[0, 0.02], 0.01, 1000],
    [[0, 0.02], NaN, 1000],
    [[0, 0.02], 1, 0],
    [[0, 0.02], 1, Infinity],
    [[0, Number.MIN_VALUE], 1, 1000],
  ])
    assert.throws(() =>
      summarizeFrameTiming(new Float64Array(values), end, resolution),
    );
});
