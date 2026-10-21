import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCSV,
  sampleAt,
  dataTimeAt,
  alignOffset,
  videoTimeAt,
  rescaleOffset,
  fitTimeMapping,
  validateTimeScale,
  outputSize,
  formatTime,
  chartPoints,
  compositionSize,
  containRect,
  cumulativeAt,
} from "../src/data.js";
import { summarizeFrameTiming, adjacentFrameTime } from "../src/timing.js";
import { compositionGeometry } from "../src/composition.js";
import { defaultStyle } from "../src/overlay.js";

test("parses the requested millisecond log without shifting its logger clock", () => {
  const data = parseCSV("time_ms;thrust;pressure\r\n16;0.4;0.0\r\n33;0.4;0.0");
  assert.equal(data.start, 0.016);
  assert.equal(data.end, 0.033);
  assert.ok(Math.abs(data.impulse - 0.0068) < 1e-10);
});
test("accepts BOM, reordered columns, decimal commas, comments, and scientific notation", () => {
  const data = parseCSV(
    '\uFEFFpressure;time_ms;thrust\n# comment\n"1,5";0;2e1\n2;100;30',
  );
  assert.equal(data.pressurePoints[0].pressure, 1.5);
  assert.equal(data.peakThrust, 30);
  assert.equal(data.impulse, 2.5);
});
test("supports comma and tab delimiters without guessing time units", () => {
  for (const delimiter of [",", "\t"]) {
    const data = parseCSV(
      ["time_ms;thrust;pressure", "0;1;2", "100;2;3"]
        .join("\n")
        .replaceAll(";", delimiter),
    );
    assert.equal(data.end, 0.1);
  }
  assert.throws(
    () => parseCSV("time;thrust;pressure\n0;1;2\n1;2;3"),
    /time_ms/,
  );
});
test("rejects malformed measurements and duplicate or decreasing timestamps", () => {
  for (const body of ["0;1;2\n0;2;3", "100;1;2\n0;2;3"]) {
    assert.throws(
      () => parseCSV(`time_ms;thrust;pressure\n${body}`),
      /increase strictly/,
    );
  }
  for (const body of [
    "0;;2\n10;2;3",
    "0;NaN;2\n10;2;3",
    "0;1;2;9\n10;2;3",
    "0;Infinity;2\n10;2;3",
  ]) {
    assert.throws(() => parseCSV(`time_ms;thrust;pressure\n${body}`), /Line 2/);
  }
});
test("linearly interpolates values and analytically integrates partial intervals", () => {
  const data = parseCSV("time_ms;thrust;pressure\n0;0;0\n500;10;20");
  const half = sampleAt(data, 0.25);
  assert.equal(half.thrust, 5);
  assert.equal(half.pressure, 10);
  assert.equal(half.impulse, 0.625);
  assert.equal(sampleAt(data, -0.1), null);
  assert.equal(sampleAt(data, 1), null);
});

test("live totals accumulate only observed peaks and impulse, including after rewinding", () => {
  const data = parseCSV("time_ms;thrust;pressure\n0;0;0\n500;10;20\n1000;2;4");
  const early = cumulativeAt(data, 0.25);
  assert.equal(early.peakThrust, 5);
  assert.equal(early.peakPressure, 10);
  assert.equal(early.impulse, 0.625);
  assert.equal(early.phase, "live");
  assert.equal(cumulativeAt(data, 0.75).peakThrust, 10);
  assert.equal(cumulativeAt(data, 0.25).peakThrust, 5);
  assert.equal(cumulativeAt(data, -0.1).impulse, 0);
  const final = cumulativeAt(data, 2);
  assert.equal(final.impulse, data.impulse);
  assert.equal(final.phase, "complete");
  assert.equal(final.progress, 1);
});

test("live totals hold the last known measurements across a gap without future values", () => {
  const data = parseCSV(
    "time_ms;thrust;pressure\n0;0;0\n100;10;2\n1000;100;20\n1100;0;0",
  );
  const gap = cumulativeAt(data, 0.6);
  assert.equal(gap.phase, "gap");
  assert.equal(gap.peakThrust, 10);
  assert.equal(gap.peakPressure, 2);
  assert.equal(gap.impulse, 0.5);
  assert.equal(cumulativeAt(data, 1).peakThrust, 100);
});
test("does not invent samples or impulse across a missing interval", () => {
  const data = parseCSV(
    "time_ms;thrust;pressure\n0;10;20\n100;10;20\n1000;10;20\n1100;10;20",
  );
  assert.equal(data.gaps, 1);
  assert.equal(sampleAt(data, 0.5), null);
  assert.ok(Math.abs(data.impulse - 2) < 1e-10);
  assert.equal(sampleAt(data, 1).thrust, 10);
});
test("alignment retains the same data time after trimming the video", () => {
  const offset = alignOffset(4.2, 0.6);
  assert.ok(Math.abs(dataTimeAt(4.2, offset) - 0.6) < 1e-10);
  const trimStart = 3;
  const outputTimestamp = 1.2;
  assert.ok(
    Math.abs(dataTimeAt(outputTimestamp + trimStart, offset) - 0.6) < 1e-10,
  );
  assert.equal(dataTimeAt(1, -2), 3);
});
test("detects the interpolated five percent ignition crossing", () => {
  const data = parseCSV("time_ms;thrust;pressure\n0;0;0\n100;100;5\n200;50;2");
  assert.ok(Math.abs(data.ignition - 0.005) < 1e-10);
});
test("keeps aspect ratio and even codec dimensions for portrait, landscape, and odd inputs", () => {
  assert.deepEqual(outputSize(3840, 2160, 1920), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize(2160, 3840, 1920), { width: 1080, height: 1920 });
  assert.deepEqual(outputSize(832, 464, 1920), { width: 832, height: 464 });
  assert.deepEqual(outputSize(641, 481, 0), { width: 642, height: 482 });
});
test("default video composition is true Full HD landscape for every source size", () => {
  assert.equal(defaultStyle.frameAspect, "landscape");
  for (const [width, height] of [
    [832, 464],
    [464, 832],
    [3840, 2160],
  ]) {
    assert.deepEqual(compositionSize(width, height), {
      width: 1920,
      height: 1080,
    });
    assert.deepEqual(
      compositionSize(width, height, 1920, defaultStyle.frameAspect),
      { width: 1920, height: 1080 },
    );
  }
});
test("rounds timecode at minute boundaries consistently", () => {
  assert.equal(formatTime(59.9998), "01:00.000");
  assert.equal(formatTime(61.25), "01:01.250");
});

test("full-frame layout preserves every source corner outside charts and details", () => {
  for (const [w, h, sw, sh] of [
    [1920, 1080, 1920, 1080],
    [1920, 1080, 1080, 1920],
    [1080, 1920, 1920, 1080],
    [1080, 1080, 640, 480],
  ]) {
    const { video, info, panelHeight } = compositionGeometry(
      w,
      h,
      sw,
      sh,
      defaultStyle,
    );
    assert.ok(Math.abs(video.width / video.height - sw / sh) < 1e-10);
    assert.ok(video.x >= 0 && video.y >= 0);
    assert.ok(video.x + video.width <= info.x + 1e-8);
    assert.ok(video.y + video.height <= h - panelHeight + 1e-8);
  }
});
test("output aspect choices use the requested size even when the source is smaller", () => {
  assert.deepEqual(compositionSize(3840, 2160, 1920, "portrait"), {
    width: 1080,
    height: 1920,
  });
  assert.deepEqual(compositionSize(1080, 1920, 1280, "landscape"), {
    width: 1280,
    height: 720,
  });
  assert.deepEqual(compositionSize(960, 540, 1920, "square"), {
    width: 1920,
    height: 1920,
  });
  assert.deepEqual(compositionSize(464, 832, 1920, "portrait"), {
    width: 1080,
    height: 1920,
  });
  assert.deepEqual(compositionSize(640, 480, 1920, "source"), {
    width: 1920,
    height: 1440,
  });
  assert.deepEqual(compositionSize(832, 464, 0, "source"), {
    width: 832,
    height: 464,
  });
  assert.deepEqual(compositionSize(832, 464, 0, "landscape"), {
    width: 832,
    height: 468,
  });
  assert.deepEqual(
    containRect(1920, 1080, { x: 0, y: 0, width: 100, height: 100 }),
    { x: 0, y: 21.875, width: 100, height: 56.25 },
  );
});
test("downsampling preserves a single narrow thrust or pressure peak", () => {
  const points = Array.from({ length: 10000 }, (_, i) => ({
    t: i / 1000,
    thrust: i === 4231 ? 1000 : 1,
    pressure: i === 6342 ? 100 : 0,
    impulse: 0,
  }));
  const reduced = chartPoints({ points, pressurePoints: points.map(({ t, pressure }) => ({ t, pressure })) }, 300);
  assert.ok(reduced.length < 1000);
  assert.equal(Math.max(...reduced.map((p) => p.thrust)), 1000);
  assert.equal(Math.max(...reduced.map((p) => p.pressure)), 100);
});
test("downsampling preserves real gap boundaries without inventing gaps in long recordings", () => {
  const csv = [
    "time_ms;thrust;pressure",
    ...Array.from(
      { length: 10000 },
      (_, i) => `${i * 100 + (i > 5000 ? 1000 : 0)};1;1`,
    ),
  ].join("\n");
  const data = parseCSV(csv);
  const reduced = chartPoints(data, 300);
  assert.equal(reduced.filter((p) => p.gapBefore).length, 1);
  assert.ok(
    reduced.some(
      (p, i) => i > 0 && p.t - reduced[i - 1].t > 0.5 && !p.gapBefore,
    ),
  );
});

test("time stretch maps original logger time in both directions and survives trimming", () => {
  const timeScale = 1.75;
  const offset = alignOffset(4.2, 0.6, timeScale);
  assert.ok(Math.abs(dataTimeAt(4.2, offset, timeScale) - 0.6) < 1e-10);
  assert.ok(Math.abs(videoTimeAt(0.6, offset, timeScale) - 4.2) < 1e-10);
  assert.ok(Math.abs(dataTimeAt(1.2 + 3, offset, timeScale) - 0.6) < 1e-10);
  assert.equal(dataTimeAt(1, -2, 2), 1.5);
});

test("changing duration keeps the chosen logger event fixed, including a nonzero CSV start", () => {
  for (const pivot of [0.016, 1.7]) {
    const offset = rescaleOffset(-0.25, 1.2, 2.5, pivot);
    assert.ok(
      Math.abs(
        videoTimeAt(pivot, offset, 2.5) - videoTimeAt(pivot, -0.25, 1.2),
      ) < 1e-10,
    );
    assert.ok(
      Math.abs(
        videoTimeAt(pivot + 1, offset, 2.5) -
          videoTimeAt(pivot, offset, 2.5) -
          2.5,
      ) < 1e-10,
    );
  }
});

test("two matching events determine one exact scale and offset", () => {
  const mapping = fitTimeMapping(0.6, 4.2, 2.6, 7.2);
  assert.equal(mapping.timeScale, 1.5);
  assert.ok(
    Math.abs(videoTimeAt(0.6, mapping.offset, mapping.timeScale) - 4.2) < 1e-10,
  );
  assert.ok(
    Math.abs(videoTimeAt(2.6, mapping.offset, mapping.timeScale) - 7.2) < 1e-10,
  );
  assert.throws(() => fitTimeMapping(1, 1, 1, 2), /later/);
  assert.throws(() => fitTimeMapping(0, 2, 1, 1), /later/);
  assert.throws(() => fitTimeMapping(0, NaN, 1, 2), /later/);
  assert.throws(() => fitTimeMapping(0, 0, 1, 20), /between/);
  for (const invalid of [0, -1, Infinity, NaN, 0.09, 10.01])
    assert.throws(() => validateTimeScale(invalid));
});

test("stretching timing never rescales sensor values or the logger-time impulse", () => {
  const data = parseCSV("time_ms;thrust;pressure\n0;0;0\n500;10;20\n1000;2;4");
  const raw = sampleAt(data, 0.25);
  const mapped = sampleAt(data, dataTimeAt(2.5, 2, 2));
  assert.deepEqual(mapped, raw);
  assert.deepEqual(
    cumulativeAt(data, dataTimeAt(2.5, 2, 2)),
    cumulativeAt(data, 0.25),
  );
  assert.equal(cumulativeAt(data, dataTimeAt(4, 2, 2)).impulse, data.impulse);
});

test("30, 60, and 120 FPS video share the 50 Hz logger clock without stretching or drift", () => {
  for (const fps of [30, 60, 120]) {
    const frames = new Float64Array(
      Array.from({ length: fps * 10 + 1 }, (_, i) => i / fps),
    );
    const timing = summarizeFrameTiming(frames, 10 + 1 / fps, 120000);
    assert.equal(timing.fps, fps);
    assert.equal(timing.variable, false);
    const data = parseCSV(
      [
        "time_ms;thrust;pressure",
        ...Array.from(
          { length: 501 },
          (_, i) => `${i * 20};${i * 2};${i * 0.2}`,
        ),
      ].join("\n"),
    );
    for (const index of [1, 253, fps * 10 - 1]) {
      const t = frames[index];
      assert.ok(
        Math.abs(sampleAt(data, dataTimeAt(t, 0)).thrust - t * 100) < 1e-8,
      );
    }
  }
});

test("two observed events correct logger timestamps recording half the elapsed time without changing amplitudes", () => {
  const mapping = fitTimeMapping(0.1, 1.2, 0.6, 2.2);
  assert.ok(Math.abs(mapping.timeScale - 2) < 1e-10);
  assert.ok(Math.abs(mapping.offset - 1) < 1e-10);
  const data = parseCSV("time_ms;thrust;pressure\n0;0;0\n100;100;2\n600;50;1");
  const csvTime = dataTimeAt(1.7, mapping.offset, mapping.timeScale);
  assert.ok(Math.abs(csvTime - 0.35) < 1e-10);
  assert.ok(Math.abs(sampleAt(data, csvTime).thrust - 75) < 1e-10);
  assert.equal(data.points[1].t, 0.1);
});

test("frame navigation follows actual presentation times for VFR and fractional FPS", () => {
  const frames = new Float64Array([0, 0.008, 0.025, 0.058, 0.066, 0.1]);
  assert.equal(summarizeFrameTiming(frames, 0.116, 1000).variable, true);
  assert.equal(adjacentFrameTime(frames, 0.025, 1), 0.058);
  assert.equal(adjacentFrameTime(frames, 0.025, -1), 0.008);
  assert.equal(adjacentFrameTime(frames, 0.04, 1), 0.058);
  assert.equal(adjacentFrameTime(frames, 0, -1), 0);
  assert.equal(adjacentFrameTime(frames, 0.1, 1), 0.1);
  const ntsc = new Float64Array(
    Array.from({ length: 1000 }, (_, i) => (i * 1001) / 30000),
  );
  assert.ok(
    Math.abs(summarizeFrameTiming(ntsc, 33.37, 30000).fps - 30000 / 1001) <
      1e-9,
  );
});

test("container millisecond quantization does not misclassify constant 120 FPS", () => {
  const frames = new Float64Array(
    Array.from({ length: 360 }, (_, i) => Math.round((i * 1000) / 120) / 1000),
  );
  assert.equal(summarizeFrameTiming(frames, 3, 1000).variable, false);
});

test("native interpolation and partial impulse stay finite across large signed sensor values", () => {
  const data = parseCSV("time_s;thrust;pressure\n0;-1e308;-1e308\n1;1e308;1e308\n2;-1e308;-1e308");
  const halfway = sampleAt(data, 0.5);
  assert.equal(halfway.thrust, 0);
  assert.equal(halfway.pressure, 0);
  assert.equal(halfway.impulse, 0);
  const rising = sampleAt(data, 0.75);
  assert.ok(Math.abs(rising.thrust / 5e307 - 1) < 1e-14);
  assert.ok(Math.abs(rising.impulse / 6.25e306 - 1) < 1e-14);
  assert.ok(Math.abs(data.impulse / 5e307 - 1) < 1e-14);
});
