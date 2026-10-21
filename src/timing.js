// @ts-check
import { UserError } from "./messages.js";

// Browser media clocks round presentation timestamps to microseconds. Comparing
// them with a tighter tolerance can identify the preceding frame indefinitely.
const MEDIA_TIME_EPSILON = 1e-6;

// Frame presentation timestamps, rather than frame counts, define the video clock.
/** @param {Float64Array} timestamps @param {number} end @param {number} resolution */
export function summarizeFrameTiming(timestamps, end, resolution) {
  if (!timestamps.length)
    throw new UserError("No video frame timestamps were found.");
  if (!Number.isFinite(resolution) || resolution <= 0)
    throw new RangeError("The video timestamp resolution must be positive and finite.");
  if (!Number.isFinite(end) || end < timestamps[timestamps.length - 1])
    throw new RangeError("The video end must not precede the final frame timestamp.");
  if (!Number.isFinite(timestamps[0]) || timestamps[0] < 0)
    throw new RangeError("Video presentation timestamps must be finite and nonnegative.");
  const intervals = new Float64Array(Math.max(0, timestamps.length - 1));
  for (let i = 1; i < timestamps.length; i++) {
    const delta = timestamps[i] - timestamps[i - 1];
    if (!Number.isFinite(timestamps[i]) || delta <= 0)
      throw new RangeError("Video presentation timestamps must increase strictly.");
    intervals[i - 1] = delta;
  }
  const deltas = intervals.sort();
  const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;
  // Low-resolution containers can alternate between neighboring timestamp ticks.
  const tolerance = Math.max(2 / resolution, median * 0.02);
  const variable = deltas.some((delta) => Math.abs(delta - median) > tolerance);
  const span = timestamps[timestamps.length - 1] - timestamps[0];
  const singleFrameRate = end > timestamps[0] ? 1 / (end - timestamps[0]) : 0;
  const fps = span > 0 ? (timestamps.length - 1) / span : singleFrameRate;
  const minFps = deltas.length ? 1 / deltas[deltas.length - 1] : singleFrameRate;
  const maxFps = deltas.length ? 1 / deltas[0] : singleFrameRate;
  if (![fps, minFps, maxFps].every(Number.isFinite))
    throw new RangeError("The video frame rate exceeds the supported numeric range.");
  return {
    frameCount: timestamps.length,
    fps,
    variable,
    minFps,
    maxFps,
    start: timestamps[0],
    end,
  };
}

/** @param {Float64Array} timestamps @param {number} time @param {number} direction */
export function adjacentFrameTime(timestamps, time, direction) {
  if (!timestamps.length) return time;
  // Find the frame containing the playhead, including seeks between frame boundaries.
  let lo = 0;
  let hi = timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timestamps[mid] <= time + MEDIA_TIME_EPSILON) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return timestamps[0];
  const current = lo - 1;
  const index = Math.max(
    0,
    Math.min(timestamps.length - 1, current + direction),
  );
  return timestamps[index];
}

/** @param {Float64Array} timestamps @param {number} time */
export function frameIndexAt(timestamps, time) {
  if (!timestamps.length || !Number.isFinite(time)) return -1;
  let lo = 0,
    hi = timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timestamps[mid] <= time + MEDIA_TIME_EPSILON) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

/** @param {Float64Array} timestamps @param {number} time @param {number} videoEnd */
export function frameInfoAt(timestamps, time, videoEnd) {
  const index = frameIndexAt(timestamps, time);
  if (index < 0) return null;
  const timestamp = timestamps[index];
  const end = timestamps[index + 1] ?? videoEnd;
  return {
    index,
    number: index + 1,
    timestamp,
    end,
    duration: Math.max(0, end - timestamp),
  };
}

// Seek inside the indexed frame, not on a fractional boundary that the browser
// may truncate backwards. The logical playhead still uses the original PTS.
/** @param {Float64Array} timestamps @param {number} time @param {number} videoEnd */
export function mediaSeekTime(timestamps, time, videoEnd) {
  const frame = frameInfoAt(timestamps, time, videoEnd);
  if (!frame || frame.duration <= 0) return time;
  const margin = Math.min(2 * MEDIA_TIME_EPSILON, frame.duration / 4);
  return Math.max(frame.timestamp + margin, Math.min(time, frame.end - margin));
}

/** @param {Float64Array} timestamps @param {number} start @param {number} end @param {number} videoEnd */
export function selectedFrameRange(timestamps, start, end, videoEnd) {
  if (!timestamps.length || end <= start || start >= videoEnd) return null;
  const first = frameIndexAt(timestamps, start);
  let lo = 0,
    hi = timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timestamps[mid] < end - 1e-7) lo = mid + 1;
    else hi = mid;
  }
  const last = lo - 1;
  return last < first
    ? null
    : { first: first + 1, last: last + 1, count: last - first + 1 };
}
