// @ts-check
import { UserError, message } from "./messages.js";
// All timeline calculations use seconds; CSV timestamps remain absolute logger times.
import { mergeSignalCurves, reduceSignal } from "./signal-curves.js";
import { positiveArea } from "./signal-math.js";
/** @typedef {{t:number, thrust?:number, pressure?:number, impulse?:number, line?:number, gapBefore?:boolean,
 * maxThrustSoFar?:number,maxPressureSoFar?:number}} NativePoint */
/** @typedef {{t:number,thrust:number|null,pressure:number|null,impulse:number}} DataPoint */
/** @typedef {NativePoint & {thrust:number}} ThrustPoint */
/** @typedef {NativePoint & {pressure:number}} PressurePoint */
/** @typedef {{points:ThrustPoint[],pressurePoints:PressurePoint[],start:number,end:number,duration:number,overallStart:number,overallEnd:number,
 * ignition:number,gaps:number,peakThrust:number,peakPressure:number|null,minThrust:number,minPressure:number|null,impulse:number,
 * warnings:import("./messages.js").Message[],sourceUnits:{time:string,pressureTime:string,thrust:string,pressure:string},gapLimit:number,
 * channels:{thrust:{start:number,end:number,duration:number,count:number,gaps:number,gapLimit:number},pressure:{start:number|null,end:number|null,duration:number,count:number,gaps:number,gapLimit:number}},
 * events:{start:number|null,end:number|null,periods:number,source:string}|null,separateTime:boolean}} BurnData */
/** @param {number} value @param {number} min @param {number} max */
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** @param {number} value */
export const preciseSeconds = (value) =>
  (Math.abs(value) < 0.0000005 ? 0 : value)
    .toFixed(6)
    .replace(/(\.\d{3}\d*?)0+$/, "$1");

export { parseCSV } from "./csv-data.js";

/** @param {BurnData} data @param {"thrust"|"pressure"} key */
export const signalPoints = (data, key) => key === "thrust" ? data.points : data.pressurePoints;

/** @param {NativePoint[]} points @param {number} time */
function sampleIndexAt(points, time) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid].t <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Sample one native clock; missing intervals are never extrapolated.
 * @param {NativePoint[]} points @param {"thrust"|"pressure"} key @param {number} time */
export function signalSample(points, key, time) {
  if (!points.length || time < points[0].t || time > points[points.length - 1].t) return null;
  const a = points[sampleIndexAt(points, time)], b = points[sampleIndexAt(points, time) + 1];
  const first = Number(a[key]);
  if (!Number.isFinite(first)) return null;
  if (!b || time === a.t) return { ...a, [key]: first };
  if (b.gapBefore) return null;
  const fraction = (time - a.t) / (b.t - a.t);
  const value = first + (Number(b[key]) - first) * fraction;
  return { t: time, [key]: value, impulse: key === "thrust"
    ? (a.impulse ?? 0) + positiveArea(first, value, time - a.t) : undefined };
}

/** @param {BurnData|null} data @param {number} time @returns {DataPoint|null} */
export function sampleAt(data, time) {
  if (!data) return null;
  const thrust = signalSample(data.points, "thrust", time);
  const pressure = signalSample(data.pressurePoints, "pressure", time);
  if (!thrust && !pressure) return null;
  return { t: time, thrust: thrust?.thrust ?? null, pressure: pressure?.pressure ?? null,
    impulse: cumulativeAt(data, time).impulse };
}

/** Locate each channel's physical source rows independently of video frames.
 * @param {BurnData|null} data @param {number} time @param {"thrust"|"pressure"} key */
export function logPositionAt(data, time, key = "thrust") {
  if (!data) return null;
  const points = signalPoints(data, key);
  if (!points.length) return { phase: "empty", first: null, second: null, fraction: 0 };
  if (time < points[0].t - 1e-9) return { phase: "before", first: null, second: null, fraction: 0 };
  if (time > points[points.length - 1].t + 1e-9) return { phase: "after", first: null, second: null, fraction: 0 };
  const index = sampleIndexAt(points, clamp(time, points[0].t, points[points.length - 1].t));
  const a = points[index], b = points[index + 1];
  if (Math.abs(time - a.t) < 1e-9 || !b) return { phase: "exact", first: a, second: null, fraction: 0 };
  if (Math.abs(time - b.t) < 1e-9) return { phase: "exact", first: b, second: null, fraction: 0 };
  return { phase: b.gapBefore ? "gap" : "interpolated", first: a, second: b, fraction: (time - a.t) / (b.t - a.t) };
}

/** @param {BurnData} data @param {number} time */
export function cumulativeAt(data, time) {
  const thrustPoints = data.points, pressurePoints = data.pressurePoints;
  const thrust = time < data.start ? null : thrustPoints[sampleIndexAt(thrustPoints, time)];
  const pressure = !pressurePoints.length || time < pressurePoints[0].t ? null : pressurePoints[sampleIndexAt(pressurePoints, time)];
  const currentThrust = signalSample(thrustPoints, "thrust", time);
  const currentPressure = signalSample(pressurePoints, "pressure", time);
  const pending = time < data.overallStart;
  const complete = time >= data.overallEnd;
  return {
    impulse: currentThrust?.impulse ?? thrust?.impulse ?? 0,
    peakThrust: Math.max(thrust?.maxThrustSoFar ?? 0, currentThrust?.thrust ?? 0),
    peakPressure: pressurePoints.length ? Math.max(pressure?.maxPressureSoFar ?? 0, currentPressure?.pressure ?? 0) : null,
    progress: clamp((time - data.start) / data.duration, 0, 1),
    phase: pending ? "pending" : complete ? "complete" :
      (!currentThrust && time >= data.start && time <= data.end) ||
      (!currentPressure && pressurePoints.length && time >= pressurePoints[0].t && time <= pressurePoints[pressurePoints.length - 1].t) ? "gap" : "live",
  };
}

// The scale is video seconds per logger second. Trimming never changes this mapping.
/** @param {number} videoTime @param {number} offset @param {number} timeScale */
export const dataTimeAt = (videoTime, offset, timeScale = 1) =>
  (videoTime - offset) / timeScale;
/** @param {number} csvTime @param {number} offset @param {number} timeScale */
export const videoTimeAt = (csvTime, offset, timeScale = 1) =>
  offset + csvTime * timeScale;
/** @param {number} videoTime @param {number} csvTime @param {number} timeScale */
export const alignOffset = (videoTime, csvTime, timeScale = 1) =>
  videoTime - csvTime * timeScale;

export const MIN_TIME_SCALE = 0.1;
export const MAX_TIME_SCALE = 10;
/** @param {number} timeScale */
export function validateTimeScale(timeScale) {
  if (
    !Number.isFinite(timeScale) ||
    timeScale < MIN_TIME_SCALE ||
    timeScale > MAX_TIME_SCALE
  )
    throw new UserError(
      "Telemetry duration must be between 10% and 1000% of the original.",
    );
  return timeScale;
}

// Keep a chosen logger event fixed in the video while adjusting duration.
/** @param {number} offset @param {number} previousScale @param {number} nextScale @param {number} csvAnchor */
export function rescaleOffset(offset, previousScale, nextScale, csvAnchor) {
  validateTimeScale(nextScale);
  return alignOffset(
    videoTimeAt(csvAnchor, offset, previousScale),
    csvAnchor,
    nextScale,
  );
}

/** @param {number} csvA @param {number} videoA @param {number} csvB @param {number} videoB */
export function fitTimeMapping(csvA, videoA, csvB, videoB) {
  if (
    ![csvA, videoA, csvB, videoB].every(Number.isFinite) ||
    csvB <= csvA ||
    videoB <= videoA
  )
    throw new UserError(
      "Point B must be later than point A in both the CSV and video.",
    );
  const timeScale = validateTimeScale((videoB - videoA) / (csvB - csvA));
  return { timeScale, offset: alignOffset(videoA, csvA, timeScale) };
}

/** @param {number} width @param {number} height @param {number} maxEdge */
export function outputSize(width, height, maxEdge = 1920) {
  const scale = maxEdge ? Math.min(1, maxEdge / Math.max(width, height)) : 1;
  return {
    width: Math.max(2, Math.round((width * scale) / 2) * 2),
    height: Math.max(2, Math.round((height * scale) / 2) * 2),
  };
}

/** @param {number} width @param {number} height @param {number} maxEdge @param {string} aspect */
export function compositionSize(
  width,
  height,
  maxEdge = 1920,
  aspect = "landscape",
) {
  const ratios = { landscape: 16 / 9, portrait: 9 / 16, square: 1 };
  const ratio =
    ratios[/** @type {keyof typeof ratios} */ (aspect)] ?? width / height;
  // A selected export size defines the composition, including for small inputs.
  // The original-size choice retains the source edge and chosen frame shape.
  const edge = maxEdge || Math.max(width, height);
  return outputSize(
    ratio >= 1 ? edge : edge * ratio,
    ratio >= 1 ? edge / ratio : edge,
    0,
  );
}

/** @param {number} sourceWidth @param {number} sourceHeight @param {{x:number,y:number,width:number,height:number}} box */
export function containRect(sourceWidth, sourceHeight, box) {
  const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/** @param {number} seconds @param {boolean} milliseconds */
export function formatTime(seconds, milliseconds = true) {
  if (!Number.isFinite(seconds)) return "00:00.000";
  const ms = Math.round(Math.abs(seconds) * 1000);
  const min = Math.floor(ms / 60000);
  const sec = Math.floor(ms / 1000) % 60;
  return `${seconds < 0 ? "−" : ""}${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}${milliseconds ? "." + String(ms % 1000).padStart(3, "0") : ""}`;
}

/** @param {number | null | undefined} value */
export const formatValue = (value) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : Math.abs(value) >= 10000 || (value !== 0 && Math.abs(value) < 0.000001)
      ? value.toExponential(2)
      : value.toLocaleString("en-US", {
          minimumFractionDigits: 1,
          maximumFractionDigits:
            value === 0
              ? 1
              : Math.min(
                  9,
                  Math.max(1, 2 - Math.floor(Math.log10(Math.abs(value)))),
                ),
        });

// Reduce each native channel before joining display-only knots.
/** @param {Pick<BurnData, 'points'|'pressurePoints'>} data @param {number} budget */
export function chartPoints(data, budget = 1400) {
  return mergeSignalCurves(reduceSignal(data.points, "thrust", budget / 2),
    reduceSignal(data.pressurePoints, "pressure", budget / 2));
}
