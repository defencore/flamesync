// @ts-check
import { validateTimeScale } from "./data.js";

/** @typedef {Readonly<{start:number,end:number,offset:number,timeScale:number,csvAnchor:number,csvEndAnchor:number}>} EditSnapshot */
/** @typedef {Readonly<{start:number,end:number}>} TimelineViewport */
/** @typedef {Float64Array | readonly number[]} FrameTimes */
/** @typedef {"start" | "end"} TrimEdge */

const MIN_TRIM_SPAN = 0.001;
const EPSILON = 1e-9;

/** @param {number} value @param {string} name */
function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite.`);
  return value;
}

/** @param {number} value @param {number} minimum @param {number} maximum */
const bound = (value, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, value));

/** @param {number} duration */
function videoDuration(duration) {
  finite(duration, "Video duration");
  if (duration < 0) throw new RangeError("Video duration cannot be negative.");
  return duration;
}

/** Capture only edit state; filenames, data, and playback state never enter history.
 * @param {EditSnapshot} state
 * @returns {EditSnapshot}
 */
export function snapshotEdit(state) {
  const { start, end, offset, timeScale, csvAnchor, csvEndAnchor } = state;
  finite(start, "In point");
  finite(end, "Out point");
  finite(offset, "Telemetry offset");
  finite(csvAnchor, "CSV start anchor");
  finite(csvEndAnchor, "CSV end anchor");
  validateTimeScale(timeScale);
  if (start < 0 || end < start)
    throw new RangeError("Trim points must be ordered and nonnegative.");
  return Object.freeze({
    start,
    end,
    offset,
    timeScale,
    csvAnchor,
    csvEndAnchor,
  });
}

/** @param {EditSnapshot} a @param {EditSnapshot} b */
export function editEquals(a, b) {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.offset === b.offset &&
    a.timeScale === b.timeScale &&
    a.csvAnchor === b.csvAnchor &&
    a.csvEndAnchor === b.csvEndAnchor
  );
}

/** First indexed timestamp at or after time. Frame timestamps are already sorted
 * by the video indexer; binary search keeps pointer updates independent of length.
 * @param {FrameTimes} times @param {number} time
 */
function lowerBound(times, time) {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle] < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** @param {number} time @param {FrameTimes} times @param {number} duration */
function boundaryBefore(time, times, duration) {
  const index = lowerBound(times, time - EPSILON) - 1;
  return index < 0 ? 0 : bound(times[index], 0, duration);
}

/** @param {number} time @param {FrameTimes} times @param {number} duration */
function boundaryAfter(time, times, duration) {
  const index = lowerBound(times, time + EPSILON);
  return index >= times.length ? duration : bound(times[index], 0, duration);
}

/** Move to the strictly preceding or following trim boundary. Unlike a frame
 * cursor, the boundary index also contains the exclusive final video duration.
 * Timestamps come sorted from the indexer; the union with 0/duration is searched
 * without allocating a second array, including when the index contains duplicates.
 * @param {number} time @param {number} direction @param {FrameTimes} timestamps
 * @param {number} duration
 */
export function stepTrimBoundary(time, direction, timestamps, duration) {
  finite(time, "Trim time");
  finite(direction, "Trim direction");
  videoDuration(duration);
  if (direction === 0) throw new RangeError("Trim direction cannot be zero.");
  const target = bound(time, 0, duration);
  if (!duration || (direction < 0 ? target === 0 : target === duration))
    return target;
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const timestamp = timestamps[middle];
    if (direction < 0 ? timestamp < target : timestamp <= target)
      low = middle + 1;
    else high = middle;
  }
  return direction < 0
    ? low > 0
      ? bound(timestamps[low - 1], 0, duration)
      : 0
    : low < timestamps.length
      ? bound(timestamps[low], 0, duration)
      : duration;
}

/** Snap to the nearest presentation boundary. Out is exclusive: an exact Out
 * stays on that boundary. Marking the displayed frame as Out should pass its end.
 * @param {number} time @param {TrimEdge} edge @param {FrameTimes} times
 * @param {number} duration
 */
export function snapFrameBoundary(time, edge, times, duration) {
  finite(time, "Trim time");
  videoDuration(duration);
  if (edge !== "start" && edge !== "end")
    throw new TypeError("Unknown trim edge.");
  const target = bound(time, 0, duration);
  if (!times.length || duration === 0) return target;
  const index = lowerBound(times, target);
  const previous = index > 0 ? bound(times[index - 1], 0, duration) : 0;
  const next =
    index < times.length ? bound(times[index], 0, duration) : duration;
  const nearest =
    target - previous < next - target ||
    (target - previous === next - target && edge === "start")
      ? previous
      : next;
  return edge === "start" && nearest >= duration
    ? boundaryBefore(duration, times, duration)
    : nearest;
}

/** Keep at least one indexed frame. Before indexing, preserve the 1 ms minimum.
 * Trimming never changes the telemetry clock or the physical sensor values.
 * @param {EditSnapshot} edit @param {TrimEdge} edge @param {number} time
 * @param {number} duration @param {FrameTimes} [times]
 * @returns {EditSnapshot}
 */
export function trimRange(edit, edge, time, duration, times = []) {
  const current = snapshotEdit(edit);
  videoDuration(duration);
  if (current.end > duration)
    throw new RangeError("The Out point exceeds the video duration.");
  const snapped = snapFrameBoundary(time, edge, times, duration);
  if (!duration) return current;
  const gap = Math.min(MIN_TRIM_SPAN, duration);
  const start =
    edge === "start"
      ? bound(
          snapped,
          0,
          times.length
            ? boundaryBefore(current.end, times, duration)
            : Math.max(0, current.end - gap),
        )
      : current.start;
  const end =
    edge === "end"
      ? bound(
          snapped,
          times.length
            ? boundaryAfter(current.start, times, duration)
            : Math.min(duration, current.start + gap),
          duration,
        )
      : current.end;
  return snapshotEdit({ ...current, start, end });
}

/** Shift a viewport back into the video while preserving its visible span.
 * @param {TimelineViewport} view @param {number} duration @param {number} [minSpan]
 * @returns {TimelineViewport}
 */
export function clampViewport(view, duration, minSpan = 0.05) {
  videoDuration(duration);
  finite(view.start, "Viewport start");
  finite(view.end, "Viewport end");
  finite(minSpan, "Minimum viewport span");
  if (view.end < view.start || minSpan <= 0)
    throw new RangeError("Viewport bounds and minimum span must be ordered.");
  const span = bound(
    view.end - view.start,
    Math.min(minSpan, duration),
    duration,
  );
  const start = bound(view.start, 0, duration - span);
  return Object.freeze({ start, end: start + span });
}

/** factor > 1 zooms in. The anchor stays at the same screen position unless a
 * video boundary prevents it, allowing zoom around either playhead or pointer.
 * @param {TimelineViewport} view @param {number} factor @param {number} anchor
 * @param {number} duration @param {number} [minSpan]
 * @returns {TimelineViewport}
 */
export function zoomViewport(view, factor, anchor, duration, minSpan = 0.05) {
  finite(factor, "Zoom factor");
  finite(anchor, "Zoom anchor");
  if (factor <= 0) throw new RangeError("Zoom factor must be positive.");
  const current = clampViewport(view, duration, minSpan);
  const span = current.end - current.start;
  if (!span) return current;
  const pivot = bound(anchor, current.start, current.end);
  const ratio = (pivot - current.start) / span;
  const nextSpan = bound(span / factor, Math.min(minSpan, duration), duration);
  const start = pivot - nextSpan * ratio;
  return clampViewport({ start, end: start + nextSpan }, duration, minSpan);
}

/** @param {TimelineViewport} view @param {number} delta @param {number} duration
 * @returns {TimelineViewport}
 */
export function panViewport(view, delta, duration) {
  finite(delta, "Pan amount");
  return clampViewport(
    { start: view.start + delta, end: view.end + delta },
    duration,
    Math.max(Number.EPSILON, view.end - view.start),
  );
}

/** Coordinate conversion is intentionally unclipped so dragging beyond the
 * visible region remains continuous; the edit or viewport operation clamps it.
 * @param {number} time @param {TimelineViewport} view @param {number} width
 */
export function timeToPixel(time, view, width) {
  finite(time, "Timeline time");
  validateCoordinates(view, width);
  return view.end === view.start
    ? 0
    : ((time - view.start) / (view.end - view.start)) * width;
}

/** @param {number} pixel @param {TimelineViewport} view @param {number} width */
export function pixelToTime(pixel, view, width) {
  finite(pixel, "Timeline pixel");
  validateCoordinates(view, width);
  return view.start + (pixel / width) * (view.end - view.start);
}

/** @param {TimelineViewport} view @param {number} width */
function validateCoordinates(view, width) {
  finite(view.start, "Viewport start");
  finite(view.end, "Viewport end");
  finite(width, "Timeline width");
  if (view.end < view.start || width <= 0)
    throw new RangeError("Timeline width must be positive and bounds ordered.");
}

/** A drag is one transaction, regardless of its pointer update count. Only the
 * six clock/trim values are retained, bounding memory independently of media.
 * @param {EditSnapshot} initial @param {{limit?:number}} [options]
 */
export function createEditHistory(initial, { limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("History limit must be a positive integer.");
  let current = snapshotEdit(initial);
  /** @type {EditSnapshot[]} */
  const past = [];
  /** @type {EditSnapshot[]} */
  const future = [];
  /** @type {EditSnapshot | null} */
  let baseline = null;

  /** @param {EditSnapshot} snapshot */
  function push(snapshot) {
    past.push(snapshot);
    if (past.length > limit) past.shift();
    future.length = 0;
  }
  function requireIdle() {
    if (baseline) throw new Error("Finish the active edit transaction first.");
  }
  function requireActive() {
    if (!baseline) throw new Error("No edit transaction is active.");
    return baseline;
  }

  return {
    get current() {
      return current;
    },
    get active() {
      return baseline !== null;
    },
    get canUndo() {
      return baseline === null && past.length > 0;
    },
    get canRedo() {
      return baseline === null && future.length > 0;
    },
    /** @param {EditSnapshot} snapshot */
    reset(snapshot) {
      current = snapshotEdit(snapshot);
      past.length = 0;
      future.length = 0;
      baseline = null;
      return current;
    },
    /** @param {EditSnapshot} snapshot */
    record(snapshot) {
      requireIdle();
      const next = snapshotEdit(snapshot);
      if (editEquals(current, next)) return current;
      push(current);
      current = next;
      return current;
    },
    begin() {
      requireIdle();
      baseline = current;
      return current;
    },
    /** @param {EditSnapshot} snapshot */
    update(snapshot) {
      requireActive();
      const next = snapshotEdit(snapshot);
      if (!editEquals(current, next)) current = next;
      return current;
    },
    commit() {
      const before = requireActive();
      baseline = null;
      if (editEquals(before, current)) current = before;
      else push(before);
      return current;
    },
    cancel() {
      current = requireActive();
      baseline = null;
      return current;
    },
    undo() {
      requireIdle();
      const previous = past.pop();
      if (previous) {
        future.push(current);
        current = previous;
      }
      return current;
    },
    redo() {
      requireIdle();
      const next = future.pop();
      if (next) {
        past.push(current);
        current = next;
      }
      return current;
    },
  };
}
