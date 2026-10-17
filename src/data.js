// @ts-check
import { UserError, message } from "./messages.js";
// All timeline calculations use seconds; CSV timestamps remain absolute logger times.
import { timeFactor, thrustFactor, pressureFactor } from "./units.js";
/** @typedef {{t:number, thrust:number, pressure:number, impulse:number, line?:number, gapBefore?:boolean,
 * maxThrustSoFar?:number, maxPressureSoFar?:number}} DataPoint */
/** @typedef {{points:DataPoint[], start:number, end:number, duration:number, ignition:number, gaps:number,
 * peakThrust:number, peakPressure:number, minThrust:number, minPressure:number, impulse:number, warnings:import("./messages.js").Message[],
 * sourceUnits:{time:string,thrust:string,pressure:string},gapLimit:number}} BurnData */
const MIN_GAP_SECONDS = 0.5;
/** @param {number} value @param {number} min @param {number} max */
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** @param {number} value */
export const preciseSeconds = (value) =>
  (Math.abs(value) < 0.0000005 ? 0 : value)
    .toFixed(6)
    .replace(/(\.\d{3}\d*?)0+$/, "$1");

/** @param {string} text @param {import('./units.js').CSVSettings} settings @returns {BurnData} */
export function parseCSV(text, settings = {}) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((text, i) => ({ text: text.trim(), line: i + 1 }))
    .filter(
      (row) =>
        row.text && !row.text.startsWith("#") && !row.text.startsWith("//"),
    );
  if (lines.length < 3)
    throw new UserError("The CSV needs a header and at least two samples.");
  const delimiter = [";", "\t", ","].find(
    (d) => lines[0].text.split(d).length >= 3,
  );
  if (!delimiter)
    throw new UserError(
      "Use semicolon, comma, or tab separated columns: time_ms;thrust;pressure (or time_us).",
    );
  /** @param {string} line */
  const cells = (line) =>
    line.split(delimiter).map((v) =>
      v
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim(),
    );
  const header = cells(lines[0].text).map((v) => v.toLowerCase());
  /** @type {Record<string,string|null>} */
  const timeColumns = {
    time_ms: "ms",
    time_us: "us",
    time_µs: "us",
    time_μs: "us",
    time_s: "s",
    time: null,
  };
  const found = header.filter((name) => Object.hasOwn(timeColumns, name));
  const timeColumn = found[0];
  const timeUnit =
    settings.timeUnit && settings.timeUnit !== "auto"
      ? settings.timeUnit
      : timeColumns[timeColumn];
  const indices = [timeColumn, "thrust", "pressure"].map((name) =>
    header.indexOf(name),
  );
  if (
    found.length !== 1 ||
    indices.some((i) => i < 0) ||
    new Set(header).size !== header.length
  ) {
    throw new UserError(
      "Required unique columns: one of time_ms, time_us, time_s, or time; thrust; pressure.",
    );
  }
  if (!timeUnit)
    throw new UserError(
      "The time column has no unit. Use time_ms/time_us/time_s, or select its unit in CSV format & units.",
    );
  const sourceUnits = {
    time: timeUnit,
    thrust: settings.thrustUnit ?? "N",
    pressure: settings.pressureUnit ?? "bar",
  };
  const timeScale = timeFactor(timeUnit),
    forceScale = thrustFactor(sourceUnits.thrust),
    pressureScale = pressureFactor(sourceUnits.pressure);
  /** @type {DataPoint[]} */
  const points = [];
  for (const row of lines.slice(1)) {
    const values = cells(row.text);
    const numbers = indices.map((i) => {
      const value = values[i]?.replace(delimiter === "," ? /$^/ : /,/g, ".");
      return value && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
        ? Number(value)
        : NaN;
    });
    if (
      values.length !== header.length ||
      numbers.some((n) => !Number.isFinite(n))
    ) {
      throw new UserError(
        "Line {value0}: every sample must contain finite numeric values in all columns.",
        { value0: row.line },
      );
    }
    const t = numbers[0] * timeScale;
    const thrust = numbers[1] * forceScale,
      pressure = numbers[2] * pressureScale;
    if (![t, thrust, pressure].every(Number.isFinite))
      throw new UserError(
        "Line {value0}: converted values exceed the supported numeric range.",
        { value0: row.line },
      );
    if (t < 0)
      throw new UserError("Line {value0}: time cannot be negative.", {
        value0: row.line,
      });
    if (points.length && t <= points[points.length - 1].t) {
      throw new UserError(
        "Line {value0}: timestamps must increase strictly. Remove duplicate or out-of-order samples.",
        { value0: row.line },
      );
    }
    points.push({
      t,
      line: row.line,
      thrust,
      pressure,
      impulse: 0,
    });
  }
  if (points.length < 2)
    throw new UserError("The CSV needs at least two samples.");
  // A bounded sample of logger intervals keeps slow acquisition rates valid.
  const intervals = [];
  const stride = Math.max(1, Math.ceil((points.length - 1) / 4096));
  for (let i = 1; i < points.length; i += stride)
    intervals.push(points[i].t - points[i - 1].t);
  intervals.sort((a, b) => a - b);
  const gapLimit = Math.max(
    MIN_GAP_SECONDS,
    intervals[Math.floor(intervals.length / 2)] * 3,
  );
  let gaps = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i],
      previous = points[i - 1];
    const dt = previous ? point.t - previous.t : 0;
    point.gapBefore = dt > gapLimit;
    if (point.gapBefore) gaps++;
    point.impulse =
      (previous?.impulse ?? 0) +
      (previous && !point.gapBefore
        ? ((Math.max(0, previous.thrust) + Math.max(0, point.thrust)) * dt) / 2
        : 0);
    point.maxThrustSoFar = Math.max(
      previous?.maxThrustSoFar ?? 0,
      point.thrust,
    );
    point.maxPressureSoFar = Math.max(
      previous?.maxPressureSoFar ?? 0,
      point.pressure,
    );
  }
  const peakThrust = points.reduce((m, p) => Math.max(m, p.thrust), 0);
  const threshold = peakThrust * 0.05;
  let ignition = points[0].t;
  const onset =
    peakThrust > 0 ? points.findIndex((p) => p.thrust >= threshold) : -1;
  if (onset > 0) {
    const a = points[onset - 1];
    const b = points[onset];
    ignition = !b.gapBefore
      ? a.t + ((threshold - a.thrust) / (b.thrust - a.thrust)) * (b.t - a.t)
      : b.t;
  }
  const start = points[0].t;
  const end = points[points.length - 1].t;
  return {
    sourceUnits,
    points,
    start,
    end,
    duration: end - start,
    ignition,
    gaps,
    gapLimit,
    peakThrust,
    peakPressure: points.reduce((m, p) => Math.max(m, p.pressure), 0),
    minThrust: points.reduce((m, p) => Math.min(m, p.thrust), 0),
    minPressure: points.reduce((m, p) => Math.min(m, p.pressure), 0),
    impulse: points[points.length - 1].impulse,
    warnings: gaps
      ? [
          message(
            "Found {count} data gaps over {limit} s. Missing intervals are not interpolated or integrated.",
            { count: gaps, limit: Number(gapLimit.toFixed(6)) },
          ),
        ]
      : [],
  };
}

/** @param {BurnData | null} data @param {number} t @returns {DataPoint | null} */
export function sampleAt(data, t) {
  if (!data || t < data.start || t > data.end) return null;
  const points = data.points;
  const lo = sampleIndexAt(points, t);
  const a = points[lo];
  const b = points[lo + 1];
  if (!b || t === a.t) return { ...a };
  if (b.gapBefore) return null;
  const u = (t - a.t) / (b.t - a.t);
  const thrust = a.thrust + (b.thrust - a.thrust) * u;
  return {
    t,
    thrust,
    pressure: a.pressure + (b.pressure - a.pressure) * u,
    impulse:
      a.impulse +
      ((Math.max(0, a.thrust) + Math.max(0, thrust)) * (t - a.t)) / 2,
  };
}

/** @param {DataPoint[]} points @param {number} t */
function sampleIndexAt(points, t) {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Locate physical CSV lines independently of the video frame rate.
 * @param {BurnData|null} data @param {number} time */
export function logPositionAt(data, time) {
  if (!data) return null;
  if (time < data.start - 1e-9)
    return { phase: "before", first: null, second: null, fraction: 0 };
  if (time > data.end + 1e-9)
    return { phase: "after", first: null, second: null, fraction: 0 };
  const index = sampleIndexAt(data.points, clamp(time, data.start, data.end));
  const a = data.points[index],
    b = data.points[index + 1];
  const exact = Math.abs(time - a.t) < 1e-9;
  if (exact || !b)
    return { phase: "exact", first: a, second: null, fraction: 0 };
  if (Math.abs(time - b.t) < 1e-9)
    return { phase: "exact", first: b, second: null, fraction: 0 };
  return {
    phase: b.gapBefore ? "gap" : "interpolated",
    first: a,
    second: b,
    fraction: (time - a.t) / (b.t - a.t),
  };
}

/** @param {BurnData} data @param {number} t */
export function cumulativeAt(data, t) {
  if (t < data.start)
    return {
      impulse: 0,
      peakThrust: 0,
      peakPressure: 0,
      progress: 0,
      phase: "pending",
    };
  if (t >= data.end)
    return {
      impulse: data.impulse,
      peakThrust: data.peakThrust,
      peakPressure: data.peakPressure,
      progress: 1,
      phase: "complete",
    };
  const previous = data.points[sampleIndexAt(data.points, t)];
  const current = sampleAt(data, t);
  return {
    impulse: current?.impulse ?? previous.impulse,
    peakThrust: Math.max(previous.maxThrustSoFar ?? 0, current?.thrust ?? 0),
    peakPressure: Math.max(
      previous.maxPressureSoFar ?? 0,
      current?.pressure ?? 0,
    ),
    progress: (t - data.start) / data.duration,
    phase: current ? "live" : "gap",
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

// Preserve narrow spikes when reducing large datasets for a pixel-limited chart.
/** @param {Pick<BurnData, 'points'>} data @param {number} budget @returns {DataPoint[]} */
export function chartPoints(data, budget = 1400) {
  if (data.points.length <= budget) return data.points;
  /** @type {DataPoint[]} */
  const out = [];
  const bucket = Math.ceil(data.points.length / (budget / 6));
  for (let i = 0; i < data.points.length; i += bucket) {
    const group = data.points.slice(i, i + bucket);
    const extrema = [group[0], group[group.length - 1]];
    for (const key of /** @type {const} */ (["thrust", "pressure"])) {
      extrema.push(group.reduce((a, b) => (a[key] < b[key] ? a : b)));
      extrema.push(group.reduce((a, b) => (a[key] > b[key] ? a : b)));
    }
    // Keep both sides of missing intervals so downsampling cannot hide a data gap.
    group.forEach((p, j) => {
      if (j && p.gapBefore) extrema.push(group[j - 1], p);
    });
    out.push(...[...new Set(extrema)].sort((a, b) => a.t - b.t));
  }
  return out;
}
