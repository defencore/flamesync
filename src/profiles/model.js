import { detectBurnInterval } from "../measurement.js";
import { signalPoints } from "../data.js";
import { mergeSignalCurves, reduceSignal } from "../signal-curves.js";
import { UserError, message } from "../messages.js";
import { positiveArea } from "../signal-math.js";

const CURVE_BUDGET = 2400;
const GRAVITY = 9.80665;
const NOISE_NOTE = "Noise is residual variation around a moving mean, including real combustion changes and measurement noise; it is not calibrated uncertainty.";

function pointAt(a, b, time, key) {
  return { t: time, [key]: a[key] + (b[key] - a[key]) * ((time - a.t) / (b.t - a.t)) };
}

function boundedCurve(thrust, pressure, budget = CURVE_BUDGET) {
  return mergeSignalCurves(
    reduceSignal(thrust, "thrust", budget / 2),
    reduceSignal(pressure, "pressure", budget / 2),
  );
}

function lowerIndex(points, time) {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (points[middle].t <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}

function validEvent(value, data) {
  return value === null || (Number.isFinite(value) && value >= data.start && value <= data.end);
}

function selectedSignalStatistics(points, key, start, end) {
  let peak = null, covered = 0, area = 0, positive = 0;
  const includePeak = (point) => { peak = Math.max(peak ?? -Infinity, point[key]); };
  for (const point of points) if (point.t >= start && point.t <= end) includePeak(point);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const left = Math.max(start, a.t), right = Math.min(end, b.t);
    if (b.gapBefore || right <= left) continue;
    const first = pointAt(a, b, left, key), last = pointAt(a, b, right, key);
    const duration = right - left;
    covered += duration;
    area += ((first[key] + last[key]) * duration) / 2;
    positive += positiveArea(first[key], last[key], duration);
    includePeak(first); includePeak(last);
  }
  return { coverage: Math.min(1, covered / (end - start)), peak,
    mean: covered > 0 ? area / covered : null, positive: covered > 0 ? positive : null };
}

function selectedStatistics(data, start, end) {
  const thrust = selectedSignalStatistics(signalPoints(data, "thrust"), "thrust", start, end);
  const pressure = selectedSignalStatistics(signalPoints(data, "pressure"), "pressure", start, end);
  return { duration: end - start, impulse: thrust.positive,
    meanThrust: thrust.mean, peakThrust: thrust.peak, coverage: thrust.coverage,
    meanPressure: pressure.mean, peakPressure: pressure.peak, pressureCoverage: pressure.coverage };
}

function continuousBlocks(points, key) {
  const blocks = [];
  let start = 0;
  for (let i = 1; i <= points.length; i++) {
    if (i < points.length && !points[i].gapBefore) continue;
    if (i - start >= 2) {
      const block = points.slice(start, i);
      const totals = new Float64Array(block.length);
      for (let j = 1; j < block.length; j++) {
        const dt = block[j].t - block[j - 1].t;
        totals[j] = totals[j - 1] + ((block[j - 1][key] + block[j][key]) * dt) / 2;
      }
      blocks.push({ points: block, totals, affine: affineRuns(block, key) });
    }
    start = i;
  }
  return blocks;
}

// A centered mean reproduces an affine signal exactly. Track maximal spans
// consistent with one line to floating-point precision, rather than allowing
// cancellation in cumulative integrals to manufacture residual variation.
// Intersect slope bounds from the span origin: checking only adjacent slopes
// could incorrectly accumulate imperceptible local curvature over a long run.
function affineRuns(points, key) {
  const runs = [];
  let start = 0, lower = -Infinity, upper = Infinity;
  const bounds = (index) => {
    const origin = points[start][key], value = points[index][key], delta = value - origin;
    const tolerance = Number.EPSILON * 8 * Math.max(Math.abs(origin), Math.abs(value), Math.abs(delta));
    const dt = points[index].t - points[start].t;
    return [(delta - tolerance) / dt, (delta + tolerance) / dt];
  };
  for (let i = 1; i < points.length; i++) {
    let [nextLower, nextUpper] = bounds(i);
    if (Math.max(lower, nextLower) > Math.min(upper, nextUpper)) {
      runs.push({ t: points[start].t, end: points[i - 1].t });
      start = i - 1;
      [nextLower, nextUpper] = bounds(i);
      lower = nextLower; upper = nextUpper;
    } else {
      lower = Math.max(lower, nextLower); upper = Math.min(upper, nextUpper);
    }
  }
  runs.push({ t: points[start].t, end: points.at(-1).t });
  return runs;
}

function affineWindow(block, time, window) {
  const runs = block.affine, run = runs[lowerIndex(runs, time)];
  const tolerance = Number.EPSILON * 4 * Math.max(Math.abs(time), Math.abs(run.t), Math.abs(run.end), window);
  return time - window / 2 >= run.t - tolerance && time + window / 2 <= run.end + tolerance;
}

function blockSample(block, time, key) {
  const points = block.points;
  const index = lowerIndex(points, time);
  const a = points[index];
  const b = points[index + 1];
  return b ? pointAt(a, b, time, key) : a;
}

function blockIntegral(block, time, key) {
  const points = block.points;
  const index = lowerIndex(points, time);
  const a = points[index];
  const b = points[index + 1];
  if (!b) return block.totals[index];
  const value = a[key] + ((b[key] - a[key]) * (time - a.t)) / (b.t - a.t);
  return block.totals[index] + ((a[key] + value) * (time - a.t)) / 2;
}

function trendSample(block, time, window, key) {
  const raw = blockSample(block, time, key);
  const value = affineWindow(block, time, window) ? raw[key] :
    (blockIntegral(block, time + window / 2, key) - blockIntegral(block, time - window / 2, key)) / window;
  return { raw: raw[key], trend: { t: time, [key]: value }, residual: { t: time, [key]: raw[key] - value } };
}

// A centered moving integral of a linear signal is quadratic between source
// knots and their ±half-window shifts. Three-point Gauss quadrature integrates
// its squared residual exactly, avoiding sample-rate-dependent noise estimates.
function signalNoiseAnalysis(points, key, window, start, end) {
  const trend = [], residual = [];
  let squares = 0, mean = 0, duration = 0;
  const nodes = [-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)];
  const weights = [5 / 9, 8 / 9, 5 / 9];
  for (const block of continuousBlocks(points, key)) {
    const source = block.points;
    const lower = source[0].t + window / 2, upper = source.at(-1).t - window / 2;
    if (upper <= lower) continue;
    const knots = [lower, upper];
    for (const point of source) {
      for (const t of [point.t - window / 2, point.t, point.t + window / 2])
        if (t > lower && t < upper) knots.push(t);
    }
    if (start !== null && start > lower && start < upper) knots.push(start);
    if (end !== null && end > lower && end < upper) knots.push(end);
    knots.sort((a, b) => a - b);
    const unique = [...new Set(knots)];
    for (let i = 0; i < unique.length; i++) {
      const sample = trendSample(block, unique[i], window, key);
      trend.push({ ...sample.trend, gapBefore: i === 0 && trend.length > 0 });
      residual.push({ ...sample.residual, gapBefore: i === 0 && residual.length > 0 });
      if (i === 0 || start === null || end === null) continue;
      const left = Math.max(start, unique[i - 1]), right = Math.min(end, unique[i]);
      if (right <= left) continue;
      const half = (right - left) / 2, middle = (right + left) / 2;
      duration += right - left;
      for (let j = 0; j < nodes.length; j++) {
        const value = trendSample(block, middle + nodes[j] * half, window, key);
        squares += half * weights[j] * value.residual[key] ** 2;
        mean += half * weights[j] * value.raw;
      }
    }
  }
  const rms = duration > 0 ? Math.sqrt(Math.max(0, squares / duration)) : null;
  return { rms, percent: duration > 0 && Math.abs(mean) > Number.EPSILON * duration
    ? rms * duration * 100 / Math.abs(mean) : null, trend, residual };
}

function noiseAnalysis(data, window, start, end) {
  const thrust = signalNoiseAnalysis(signalPoints(data, "thrust"), "thrust", window, start, end);
  const pressure = signalNoiseAnalysis(signalPoints(data, "pressure"), "pressure", window, start, end);
  return { noiseThrustRms: thrust.rms, noisePressureRms: pressure.rms,
    noiseThrustPercent: thrust.percent, noisePressurePercent: pressure.percent,
    trend: boundedCurve(thrust.trend, pressure.trend), residual: boundedCurve(thrust.residual, pressure.residual) };
}

/** Analyze source-clock telemetry. Noise includes combustion variation and
 * measurement noise; it is not a calibrated measurement uncertainty. */
export function analyseProfile(data, options = {}) {
  const threshold = options.threshold ?? 5;
  const detected = detectBurnInterval(data, threshold);
  const start = options.start === undefined ? detected.start : options.start;
  const end = options.end === undefined ? detected.end : options.end;
  if (!validEvent(start, data) || !validEvent(end, data) || (start !== null && end !== null && end <= start))
    throw new UserError("Choose ignition before burnout, with both events inside the CSV time range.");
  const massKg = options.massKg ?? null;
  if (massKg !== null && (!Number.isFinite(massKg) || massKg <= 0))
    throw new UserError("Propellant mass must be a positive number in kilograms.");
  const window = options.noiseWindow ?? 0.1;
  if (!Number.isFinite(window) || window <= 0)
    throw new UserError("The noise moving window must be a positive number of seconds.");
  const complete = start !== null && end !== null;
  const noiseStart = options.noiseStart === undefined ? (complete ? start + (end - start) * 0.1 : null) : options.noiseStart;
  const noiseEnd = options.noiseEnd === undefined ? (complete ? end - (end - start) * 0.1 : null) : options.noiseEnd;
  if (!validEvent(noiseStart, data) || !validEvent(noiseEnd, data) || (noiseStart !== null && noiseEnd !== null && noiseEnd <= noiseStart))
    throw new UserError("Choose a noise interval with its start before its end, inside the CSV time range.");
  const warnings = [...(data.warnings ?? [])];
  if (options.start === undefined || options.end === undefined)
    warnings.push(...detected.warnings.filter(({ key }) => !((options.start !== undefined && key.includes("Set A manually")) || (options.end !== undefined && key.includes("Set B manually")))));
  const statistics = complete ? selectedStatistics(data, start, end) : {
    duration: null, impulse: null, meanThrust: null, peakThrust: null,
    meanPressure: null, peakPressure: null, coverage: null, pressureCoverage: null,
  };
  const hasMissingData = complete && data.points.some((point, index) =>
    index > 0 && point.gapBefore && data.points[index - 1].t < end && point.t > start);
  if (!complete)
    warnings.push(message("Set both ignition and burnout events to calculate burn statistics."));
  else if (hasMissingData)
    warnings.push(message("The selected burn interval contains missing data. Integrals and means use only covered intervals; specific impulse is unavailable."));
  const noise = noiseAnalysis(data, window, complete ? noiseStart : null, complete ? noiseEnd : null);
  if (complete && noise.noiseThrustRms === null)
    warnings.push(message("Noise cannot be estimated: no complete moving window lies inside the selected noise interval."));
  warnings.push(message(NOISE_NOTE));
  const specificImpulse = massKg !== null && statistics.impulse !== null && !hasMissingData && statistics.coverage >= 1 - 1e-10
    ? statistics.impulse / (massKg * GRAVITY) : null;
  const { trend, residual, ...noiseStatistics } = noise;
  return {
    start, end, ...statistics, ...noiseStatistics, noiseStart, noiseEnd,
    specificImpulse, warnings,
    curves: { raw: boundedCurve(signalPoints(data, "thrust"), signalPoints(data, "pressure")), trend, residual },
  };
}

/** Map source seconds to shared logger time, event-relative time, or burn phase. */
export function profileMapping(profile, mode) {
  if (mode === "source") return { offset: 0, scale: 1 };
  if (mode === "ignition")
    return Number.isFinite(profile.start) ? { offset: -profile.start, scale: 1 } : null;
  if (mode === "burnout")
    return Number.isFinite(profile.end) ? { offset: -profile.end, scale: 1 } : null;
  if (mode === "normalized") {
    if (!Number.isFinite(profile.start) || !Number.isFinite(profile.end) || profile.end <= profile.start) return null;
    const scale = 100 / (profile.end - profile.start);
    return { offset: -profile.start * scale, scale };
  }
  throw new UserError("Unknown profile alignment mode.");
}

function mappedSegments(points, mapping, key) {
  const { offset, scale } = mapping;
  const segments = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (b.gapBefore) continue;
    segments.push({ a: { t: offset + a.t * scale, [key]: a[key] }, b: { t: offset + b.t * scale, [key]: b[key] } });
  }
  return segments;
}

function compareSignal(referenceData, referenceMapping, candidateData, candidateMapping, key, mappedStart, mappedEnd) {
  const reference = mappedSegments(signalPoints(referenceData, key), referenceMapping, key);
  const candidate = mappedSegments(signalPoints(candidateData, key), candidateMapping, key);
  const points = [];
  let integral = 0, absolute = 0, squared = 0, maxAbs = 0, covered = 0, r = 0, c = 0, previousEnd = null;
  const delta = (left, right, time) => ({ t: time,
    [key]: pointAt(right.a, right.b, time, key)[key] - pointAt(left.a, left.b, time, key)[key] });
  while (r < reference.length && c < candidate.length) {
    const left = reference[r], right = candidate[c];
    const start = Math.max(left.a.t, right.a.t, mappedStart), end = Math.min(left.b.t, right.b.t, mappedEnd);
    if (end > start) {
      const first = delta(left, right, start), last = delta(left, right, end), duration = end - start;
      const a = first[key], b = last[key];
      covered += duration;
      integral += ((a + b) * duration) / 2;
      absolute += positiveArea(a, b, duration) + positiveArea(-a, -b, duration);
      squared += ((a * a + a * b + b * b) * duration) / 3;
      maxAbs = Math.max(maxAbs, Math.abs(a), Math.abs(b));
      if (previousEnd !== start) points.push({ ...first, gapBefore: previousEnd !== null });
      points.push({ ...last, gapBefore: false });
      previousEnd = end;
    }
    if (left.b.t <= right.b.t) r++;
    else c++;
  }
  return { points, covered, metrics: covered > 0 ? {
    bias: integral / covered, mae: absolute / covered,
    rmse: Math.sqrt(Math.max(0, squared / covered)), maxAbs,
  } : { bias: null, mae: null, rmse: null, maxAbs: null } };
}

/** Candidate minus reference, integrated over each channel's native common
 * support. Normalized comparisons are weighted by phase, never by frames. */
export function compareProfiles(referenceData, referenceMapping, candidateData, candidateMapping, options = {}) {
  if (!referenceMapping || !candidateMapping) return null;
  for (const mapping of [referenceMapping, candidateMapping])
    if (!Number.isFinite(mapping.offset) || !Number.isFinite(mapping.scale) || mapping.scale <= 0)
      throw new UserError("Profile alignment must have a finite offset and a positive scale.");
  const mappedStart = Math.max(
    referenceMapping.offset + referenceData.start * referenceMapping.scale,
    candidateMapping.offset + candidateData.start * candidateMapping.scale,
    options.start ?? -Infinity,
  );
  const mappedEnd = Math.min(
    referenceMapping.offset + referenceData.end * referenceMapping.scale,
    candidateMapping.offset + candidateData.end * candidateMapping.scale,
    options.end ?? Infinity,
  );
  if (!(mappedEnd > mappedStart)) return null;
  const thrust = compareSignal(referenceData, referenceMapping, candidateData, candidateMapping, "thrust", mappedStart, mappedEnd);
  const pressure = compareSignal(referenceData, referenceMapping, candidateData, candidateMapping, "pressure", mappedStart, mappedEnd);
  if (!(thrust.covered > 0 || pressure.covered > 0)) return null;
  return { thrust: thrust.metrics, pressure: pressure.metrics,
    coverage: Math.min(1, thrust.covered / (mappedEnd - mappedStart)),
    pressureCoverage: Math.min(1, pressure.covered / (mappedEnd - mappedStart)),
    start: mappedStart, end: mappedEnd, duration: mappedEnd - mappedStart,
    points: boundedCurve(thrust.points, pressure.points, options.budget ?? CURVE_BUDGET) };
}
