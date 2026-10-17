import test from "node:test";
import assert from "node:assert/strict";
import {
  snapshotEdit,
  editEquals,
  trimRange,
  snapFrameBoundary,
  stepTrimBoundary,
  clampViewport,
  zoomViewport,
  panViewport,
  timeToPixel,
  pixelToTime,
  createEditHistory,
} from "../src/edit-model.js";
import {
  dataTimeAt,
  videoTimeAt,
  fitTimeMapping,
  parseCSV,
  sampleAt,
} from "../src/data.js";

const initial = () => ({
  start: 0,
  end: 10,
  offset: 0,
  timeScale: 1,
  csvAnchor: 0,
  csvEndAnchor: 10,
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} ≠ ${b}`);
const frames = new Float64Array([0, 0.01, 0.035, 0.1]);

test("history snapshots retain only immutable edit values and chosen CSV anchors", () => {
  const state = { ...initial(), file: { name: "large-video.mp4" } };
  const snapshot = snapshotEdit(state);
  state.start = 4;
  state.csvAnchor = 2;
  assert.deepEqual(Object.keys(snapshot), [
    "start",
    "end",
    "offset",
    "timeScale",
    "csvAnchor",
    "csvEndAnchor",
  ]);
  assert.equal(snapshot.start, 0);
  assert.equal(snapshot.csvAnchor, 0);
  assert.ok(Object.isFrozen(snapshot));
  assert.throws(() => {
    snapshot.offset = 5;
  }, TypeError);
  assert.ok(editEquals(snapshot, initial()));
  assert.ok(!editEquals(snapshot, { ...initial(), csvEndAnchor: 9 }));
});

test("invalid snapshots cannot introduce reversed bounds or corrupt either clock", () => {
  for (const change of [
    { start: -1 },
    { start: 11 },
    { end: NaN },
    { offset: Infinity },
    { timeScale: 0 },
    { timeScale: 11 },
    { csvAnchor: NaN },
    { csvEndAnchor: Infinity },
  ])
    assert.throws(() => snapshotEdit({ ...initial(), ...change }));
});

test("VFR trim snaps to presentation boundaries and keeps Out exclusive", () => {
  const edit = { ...initial(), end: 0.15 };
  const selected = trimRange(edit, "end", 0.036, 0.15, frames);
  assert.equal(selected.end, 0.035);
  assert.equal(
    trimRange(selected, "end", selected.end, 0.15, frames).end,
    0.035,
  );
  assert.equal(trimRange(selected, "start", 0.14, 0.15, frames).start, 0.01);
  const oneFrame = trimRange(edit, "start", 0.15, 0.15, frames);
  assert.equal(oneFrame.start, 0.1);
  assert.equal(oneFrame.end, 0.15);
  assert.equal(trimRange(oneFrame, "end", 0, 0.15, frames).end, 0.15);
});

test("snapping handles exact boundaries, midpoint direction, first PTS, and final duration", () => {
  assert.equal(snapFrameBoundary(0.035, "end", frames, 0.15), 0.035);
  assert.equal(snapFrameBoundary(0.005, "start", frames, 0.15), 0);
  assert.equal(snapFrameBoundary(0.005, "end", frames, 0.15), 0.01);
  assert.equal(snapFrameBoundary(-4, "start", frames, 0.15), 0);
  assert.equal(snapFrameBoundary(99, "start", frames, 0.15), 0.1);
  assert.equal(snapFrameBoundary(99, "end", frames, 0.15), 0.15);
  const delayed = new Float64Array([0.02]);
  assert.equal(snapFrameBoundary(0, "start", delayed, 0.04), 0);
  assert.equal(snapFrameBoundary(0.039, "start", delayed, 0.04), 0.02);
  assert.throws(() => snapFrameBoundary(0, "unknown", frames, 0.15));
});

test("trim boundary stepping includes final duration without skipping the last indexed frame", () => {
  assert.equal(stepTrimBoundary(0.15, 1, frames, 0.15), 0.15);
  assert.equal(stepTrimBoundary(0.15, -1, frames, 0.15), 0.1);
  assert.equal(stepTrimBoundary(0.1, 1, frames, 0.15), 0.15);
  assert.equal(stepTrimBoundary(0, -1, frames, 0.15), 0);
  assert.equal(stepTrimBoundary(0, 1, frames, 0.15), 0.01);
  assert.equal(stepTrimBoundary(0.035, -1, frames, 0.15), 0.01);
  assert.equal(stepTrimBoundary(0.035, 1, frames, 0.15), 0.1);
  assert.equal(stepTrimBoundary(0.023, -1, frames, 0.15), 0.01);
  assert.equal(stepTrimBoundary(0.023, 1, frames, 0.15), 0.035);
  assert.equal(
    stepTrimBoundary(0.035 + Number.EPSILON, -1, frames, 0.15),
    0.035,
  );
});

test("trim boundary stepping treats endpoints and repeated PTS as a union", () => {
  const delayed = new Float64Array([0.02, 0.02, 0.04, 0.04]);
  assert.equal(stepTrimBoundary(0, 1, delayed, 0.04), 0.02);
  assert.equal(stepTrimBoundary(0.02, -1, delayed, 0.04), 0);
  assert.equal(stepTrimBoundary(0.02, 1, delayed, 0.04), 0.04);
  assert.equal(stepTrimBoundary(0.04, -1, delayed, 0.04), 0.02);
  assert.equal(stepTrimBoundary(0.5, -1, [], 1), 0);
  assert.equal(stepTrimBoundary(0.5, 1, [], 1), 1);
  assert.equal(stepTrimBoundary(-10, -1, frames, 0.15), 0);
  assert.equal(stepTrimBoundary(10, 1, frames, 0.15), 0.15);
  assert.equal(stepTrimBoundary(0, 1, [], 0), 0);
  for (const args of [
    [NaN, 1, frames, 0.15],
    [0, Infinity, frames, 0.15],
    [0, 1, frames, NaN],
    [0, 1, frames, -1],
    [0, 0, frames, 0.15],
  ])
    assert.throws(() => stepTrimBoundary(...args));
});

test("manual trim keeps exact seconds while guarding crossings, even on a sub-millisecond video", () => {
  const edit = { ...initial(), end: 2 };
  assert.equal(trimRange(edit, "start", 1.001, 2).start, 1.001);
  assert.equal(trimRange(edit, "end", -1, 2).end, 0.001);
  close(trimRange(edit, "start", 3, 2).start, 1.999);
  const tiny = { ...initial(), end: 0.0005 };
  assert.equal(trimRange(tiny, "start", 2, 0.0005).start, 0);
  assert.equal(trimRange(tiny, "end", 0, 0.0005).end, 0.0005);
  assert.throws(() => trimRange(edit, "end", Infinity, 2));
  assert.throws(() => trimRange(edit, "start", 0, 1));
  const unloaded = { ...initial(), end: 0 };
  assert.deepEqual(trimRange(unloaded, "end", 1, 0), unloaded);
});

test("nonzero CSV clocks and two-event alignment remain unchanged by trimming or undo", () => {
  const log = parseCSV(
    "time_ms;thrust;pressure\n2500;0;0\n3000;10;5\n3500;0;0",
  );
  const mapping = fitTimeMapping(2.5, 4, 3.5, 6);
  const edit = snapshotEdit({
    ...initial(),
    ...mapping,
    csvAnchor: 2.5,
    csvEndAnchor: 3.5,
  });
  const history = createEditHistory(edit);
  history.record(trimRange(edit, "start", 3.75, 10));
  history.record(trimRange(history.current, "end", 7, 10));
  close(videoTimeAt(2.5, history.current.offset, history.current.timeScale), 4);
  close(dataTimeAt(5, history.current.offset, history.current.timeScale), 3);
  assert.equal(
    sampleAt(log, dataTimeAt(5, mapping.offset, mapping.timeScale)).thrust,
    10,
  );
  assert.equal(log.impulse, 5);
  assert.equal(history.current.csvAnchor, 2.5);
  history.undo();
  history.undo();
  assert.deepEqual(history.current, edit);
});

test("clamping and panning preserve visible span at both source boundaries", () => {
  assert.deepEqual(clampViewport({ start: -2, end: 2 }, 10), {
    start: 0,
    end: 4,
  });
  assert.deepEqual(clampViewport({ start: 8, end: 12 }, 10), {
    start: 6,
    end: 10,
  });
  assert.deepEqual(clampViewport({ start: -20, end: 30 }, 10), {
    start: 0,
    end: 10,
  });
  assert.deepEqual(panViewport({ start: 2, end: 4 }, 100, 10), {
    start: 8,
    end: 10,
  });
  assert.deepEqual(panViewport({ start: 2, end: 4 }, -100, 10), {
    start: 0,
    end: 2,
  });
  const narrow = panViewport({ start: 2, end: 2.01 }, 1, 10);
  close(narrow.end - narrow.start, 0.01);
  assert.ok(Object.isFrozen(narrow));
});

test("zoom stays anchored at its screen position and respects minimum span", () => {
  const view = { start: 10, end: 30 };
  const zoomed = zoomViewport(view, 2, 15, 100);
  assert.deepEqual(zoomed, { start: 12.5, end: 22.5 });
  close(timeToPixel(15, zoomed, 800), timeToPixel(15, view, 800));
  assert.deepEqual(zoomViewport(zoomed, 0.5, 15, 100), view);
  assert.deepEqual(zoomViewport(view, 0.001, 15, 100), { start: 0, end: 100 });
  const closest = zoomViewport(view, 1e10, 15, 100, 0.02);
  close(closest.end - closest.start, 0.02);
  assert.throws(() => zoomViewport(view, 0, 15, 100));
  assert.throws(() => clampViewport({ start: 3, end: 2 }, 100));
  assert.throws(() => clampViewport(view, Infinity));
});

test("coordinate conversion shares one unclipped time axis for tracks and playhead", () => {
  const view = { start: 12, end: 16 };
  for (const time of [10, 12, 13.125, 16, 20])
    close(pixelToTime(timeToPixel(time, view, 960), view, 960), time);
  assert.equal(timeToPixel(10, view, 960), -480);
  assert.equal(pixelToTime(1200, view, 960), 17);
  assert.deepEqual(clampViewport({ start: 0, end: 0 }, 0), {
    start: 0,
    end: 0,
  });
  assert.deepEqual(zoomViewport({ start: 0, end: 0 }, 2, 0, 0), {
    start: 0,
    end: 0,
  });
  assert.equal(timeToPixel(0, { start: 0, end: 0 }, 960), 0);
  assert.equal(pixelToTime(0, { start: 0, end: 0 }, 960), 0);
  assert.throws(() => pixelToTime(0, view, 0));
});

test("thousands of drag updates produce one undo step including its anchor choices", () => {
  const history = createEditHistory(initial());
  const before = history.begin();
  for (let i = 1; i <= 10000; i++)
    history.update({ ...initial(), offset: i / 1000, csvAnchor: 2 });
  assert.equal(history.active, true);
  assert.equal(history.canUndo, false);
  assert.throws(() => history.undo(), /transaction/);
  history.commit();
  assert.equal(history.current.offset, 10);
  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo(), before);
  assert.equal(history.canUndo, false);
  assert.equal(history.redo().csvAnchor, 2);
});

test("cancel and no-op commits preserve the redo branch and exact snapshot identity", () => {
  const history = createEditHistory(initial());
  history.record({ ...initial(), offset: 2, csvEndAnchor: 8 });
  const baseline = history.undo();
  assert.equal(history.record(initial()), baseline);
  assert.equal(history.canRedo, true);
  history.begin();
  history.update({ ...initial(), offset: 100 });
  assert.equal(history.cancel(), baseline);
  assert.equal(history.canRedo, true);
  history.begin();
  history.update({ ...initial(), start: 1 });
  history.update(initial());
  assert.equal(history.commit(), baseline);
  assert.equal(history.redo().csvEndAnchor, 8);
  assert.throws(() => history.commit(), /No edit transaction/);
  assert.throws(() => history.update(initial()), /No edit transaction/);
});

test("history bounds memory, clears a redo branch only after an edit, and resets on source replacement", () => {
  const history = createEditHistory(initial(), { limit: 2 });
  for (let i = 1; i <= 4; i++) history.record({ ...initial(), offset: i });
  assert.equal(history.undo().offset, 3);
  assert.equal(history.undo().offset, 2);
  assert.equal(history.undo().offset, 2);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);
  history.record({ ...initial(), offset: 20 });
  assert.equal(history.canRedo, false);
  assert.equal(history.redo().offset, 20);
  history.begin();
  history.update({ ...initial(), offset: 99 });
  const replacement = { ...initial(), end: 25, csvAnchor: 8, csvEndAnchor: 20 };
  assert.deepEqual(history.reset(replacement), replacement);
  assert.equal(history.active, false);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.throws(() => history.reset({ ...initial(), timeScale: 0 }));
  assert.deepEqual(history.current, replacement);
  assert.throws(() => createEditHistory(initial(), { limit: 0 }));
});

test("long high-frame-rate sources use indexed lookup without scanning or copying the recording", () => {
  const count = 1_000_000;
  let reads = 0;
  const timestamps = new Proxy([], {
    get(_target, key) {
      if (key === "length") return count;
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads++;
        return Number(key) / 120;
      }
      return undefined;
    },
  });
  const duration = count / 120;
  const edit = { ...initial(), end: duration };
  const result = trimRange(
    edit,
    "start",
    duration - 0.001,
    duration,
    timestamps,
  );
  close(result.start, (count - 1) / 120);
  assert.equal(result.end, duration);
  assert.ok(reads < 100, `Indexed trim read ${reads} timestamps.`);
});

test("trim boundary stepping searches a million timestamps logarithmically without copying", () => {
  const count = 1_000_000;
  let reads = 0;
  const timestamps = new Proxy([], {
    get(_target, key) {
      if (key === "length") return count;
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads++;
        return Number(key) / 120;
      }
      throw new Error(
        `Boundary stepping must not copy or iterate: ${String(key)}`,
      );
    },
  });
  const duration = count / 120;
  close(
    stepTrimBoundary(duration, -1, timestamps, duration),
    (count - 1) / 120,
  );
  const middle = 500_000 / 120;
  close(stepTrimBoundary(middle, 1, timestamps, duration), 500_001 / 120);
  close(stepTrimBoundary(middle, -1, timestamps, duration), 499_999 / 120);
  assert.equal(stepTrimBoundary(duration, 1, timestamps, duration), duration);
  assert.ok(reads < 75, `Boundary stepping read ${reads} timestamps.`);
});
