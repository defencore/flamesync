import { detectBurnInterval } from "../measurement.js";
import { UserError, message } from "../messages.js";

const CURVE_BUDGET = 2400;
const GRAVITY = 9.80665;
const KEYS = ["thrust", "pressure"];
const NOISE_NOTE = "Noise is residual variation around a moving mean, including real combustion changes and measurement noise; it is not calibrated uncertainty.";

function pointAt(a, b, time) {
  const fraction = (time - a.t) / (b.t - a.t);
  return {
    t: time,
    thrust: a.thrust + (b.thrust - a.thrust) * fraction,
    pressure: a.pressure + (b.pressure - a.pressure) * fraction,
  };
}

// Integrate the positive portion of a line exactly, including a zero crossing.
function positiveArea(a, b, duration) {
  if (a >= 0 && b >= 0) return ((a + b) * duration) / 2;
  if (a <= 0 && b <= 0) return 0;
  return (duration * Math.max(a, b) ** 2) / (2 * Math.abs(b - a));
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

// Preserve force/pressure extrema in each bucket. A skipped gap always breaks
// the reduced curve, even when there are more gaps than the display budget.
function boundedCurve(points, budget = CURVE_BUDGET) {
  const limit = Math.max(6, Math.floor(budget));
  const indices = [];
  if (points.length <= limit) {
    for (let i = 0; i < points.length; i++) indices.push(i);
  } else {
    const groups = Math.max(1, Math.floor(limit / 6));
    const stride = Math.ceil(points.length / groups);
    for (let start = 0; start < points.length; start += stride) {
      const end = Math.min(points.length, start + stride);
      const selected = [start, end - 1];
      for (const key of KEYS) {
        let minimum = start;
        let maximum = start;
        for (let i = start + 1; i < end; i++) {
          if (points[i][key] < points[minimum][key]) minimum = i;
          if (points[i][key] > points[maximum][key]) maximum = i;
        }
        selected.push(minimum, maximum);
      }
      indices.push(...[...new Set(selected)].sort((a, b) => a - b));
    }
  }
  let previous = -1;
  return indices.map((index) => {
    let gapBefore = !!points[index].gapBefore;
    for (let i = previous + 1; i <= index; i++)
      gapBefore ||= !!points[i].gapBefore;
    previous = index;
    const { t, thrust, pressure } = points[index];
    return { t, thrust, pressure, gapBefore };
  });
}

function validEvent(value, data) {
  return value === null || (Number.isFinite(value) && value >= data.start && value <= data.end);
}

function selectedStatistics(data, start, end) {
  const result = {
    duration: end - start,
    impulse: 0,
    meanThrust: null,
    peakThrust: null,
    meanPressure: null,
    peakPressure: null,
    coverage: 0,
  };
  let covered = 0;
  let force = 0;
  let pressure = 0;
  const peak = (point) => {
    result.peakThrust = Math.max(result.peakThrust ?? -Infinity, point.thrust);
    result.peakPressure = Math.max(result.peakPressure ?? -Infinity, point.pressure);
  };
  for (const point of data.points)
    if (point.t >= start && point.t <= end) peak(point);
  for (let i = 1; i < data.points.length; i++) {
    const a = data.points[i - 1];
    const b = data.points[i];
    const left = Math.max(start, a.t);
    const right = Math.min(end, b.t);
    if (b.gapBefore || right <= left) continue;
    const first = pointAt(a, b, left);
    const last = pointAt(a, b, right);
    const duration = right - left;
    covered += duration;
    result.impulse += positiveArea(first.thrust, last.thrust, duration);
    force += ((first.thrust + last.thrust) * duration) / 2;
    pressure += ((first.pressure + last.pressure) * duration) / 2;
    peak(first);
    peak(last);
  }
  result.coverage = Math.min(1, covered / result.duration);
  if (covered > 0) {
    result.meanThrust = force / covered;
    result.meanPressure = pressure / covered;
  } else {
    result.impulse = null;
  }
  return result;
}

function continuousBlocks(points) {
  const blocks = [];
  let start = 0;
  for (let i = 1; i <= points.length; i++) {
    if (i < points.length && !points[i].gapBefore) continue;
    if (i - start >= 2) {
      const block = points.slice(start, i);
      const totals = { thrust: new Float64Array(block.length), pressure: new Float64Array(block.length) };
      for (let j = 1; j < block.length; j++) {
        const dt = block[j].t - block[j - 1].t;
        for (const key of KEYS)
          totals[key][j] = totals[key][j - 1] + ((block[j - 1][key] + block[j][key]) * dt) / 2;
      }
      blocks.push({ points: block, totals });
    }
    start = i;
  }
  return blocks;
}

function blockSample(block, time) {
  const points = block.points;
  const index = lowerIndex(points, time);
  const a = points[index];
  const b = points[index + 1];
  return b ? pointAt(a, b, time) : a;
}

function blockIntegral(block, time, key) {
  const points = block.points;
  const index = lowerIndex(points, time);
  const a = points[index];
  const b = points[index + 1];
  if (!b) return block.totals[key][index];
  const value = a[key] + ((b[key] - a[key]) * (time - a.t)) / (b.t - a.t);
  return block.totals[key][index] + ((a[key] + value) * (time - a.t)) / 2;
}

function trendSample(block, time, window) {
  const half = window / 2;
  const raw = blockSample(block, time);
  const trend = { t: time, thrust: 0, pressure: 0 };
  const residual = { t: time, thrust: 0, pressure: 0 };
  for (const key of KEYS) {
    trend[key] = (blockIntegral(block, time + half, key) - blockIntegral(block, time - half, key)) / window;
    residual[key] = raw[key] - trend[key];
  }
  return { raw, trend, residual };
}

// A centered moving integral of a linear signal is quadratic between source
// knots and their ±half-window shifts. Three-point Gauss quadrature integrates
// its squared residual exactly, avoiding sample-rate-dependent noise estimates.
function noiseAnalysis(data, window, start, end) {
  const trend = [];
  const residual = [];
  const squares = { thrust: 0, pressure: 0 };
  const means = { thrust: 0, pressure: 0 };
  let duration = 0;
  const nodes = [-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)];
  const weights = [5 / 9, 8 / 9, 5 / 9];
  for (const block of continuousBlocks(data.points)) {
    const points = block.points;
    const lower = points[0].t + window / 2;
    const upper = points.at(-1).t - window / 2;
    if (upper <= lower) continue;
    const knots = [lower, upper];
    for (const point of points) {
      for (const t of [point.t - window / 2, point.t, point.t + window / 2])
        if (t > lower && t < upper) knots.push(t);
    }
    if (start !== null && start > lower && start < upper) knots.push(start);
    if (end !== null && end > lower && end < upper) knots.push(end);
    knots.sort((a, b) => a - b);
    const unique = [...new Set(knots)];
    for (let i = 0; i < unique.length; i++) {
      const sample = trendSample(block, unique[i], window);
      trend.push({ ...sample.trend, gapBefore: i === 0 && trend.length > 0 });
      residual.push({ ...sample.residual, gapBefore: i === 0 && residual.length > 0 });
      if (i === 0 || start === null || end === null) continue;
      const left = Math.max(start, unique[i - 1]);
      const right = Math.min(end, unique[i]);
      if (right <= left) continue;
      const half = (right - left) / 2;
      const middle = (right + left) / 2;
      duration += right - left;
      for (let j = 0; j < nodes.length; j++) {
        const value = trendSample(block, middle + nodes[j] * half, window);
        for (const key of KEYS) {
          squares[key] += half * weights[j] * value.residual[key] ** 2;
          means[key] += half * weights[j] * value.raw[key];
        }
      }
    }
  }
  const rms = (key) => duration > 0 ? Math.sqrt(Math.max(0, squares[key] / duration)) : null;
  const percent = (key) => duration > 0 && Math.abs(means[key]) > Number.EPSILON * duration
    ? (rms(key) * duration * 100) / Math.abs(means[key]) : null;
  return {
    noiseThrustRms: rms("thrust"),
    noisePressureRms: rms("pressure"),
    noiseThrustPercent: percent("thrust"),
    noisePressurePercent: percent("pressure"),
    trend: boundedCurve(trend),
    residual: boundedCurve(residual),
  };
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
    meanPressure: null, peakPressure: null, coverage: null,
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
    curves: { raw: boundedCurve(data.points), trend, residual },
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

function mappedSegments(data, mapping) {
  const { offset, scale } = mapping;
  const segments = [];
  for (let i = 1; i < data.points.length; i++) {
    const a = data.points[i - 1];
    const b = data.points[i];
    if (b.gapBefore) continue;
    segments.push({
      a: { t: offset + a.t * scale, thrust: a.thrust, pressure: a.pressure },
      b: { t: offset + b.t * scale, thrust: b.thrust, pressure: b.pressure },
    });
  }
  return segments;
}

/** Candidate minus reference, integrated over common valid aligned intervals.
 * Normalized comparisons are weighted by shared burn phase, never by frames. */
export function compareProfiles(referenceData, referenceMapping, candidateData, candidateMapping, options = {}) {
  if (!referenceMapping || !candidateMapping) return null;
  for (const mapping of [referenceMapping, candidateMapping])
    if (!Number.isFinite(mapping.offset) || !Number.isFinite(mapping.scale) || mapping.scale <= 0)
      throw new UserError("Profile alignment must have a finite offset and a positive scale.");
  const reference = mappedSegments(referenceData, referenceMapping);
  const candidate = mappedSegments(candidateData, candidateMapping);
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
  const metrics = {
    thrust: { integral: 0, absolute: 0, squared: 0, maxAbs: 0 },
    pressure: { integral: 0, absolute: 0, squared: 0, maxAbs: 0 },
  };
  const points = [];
  let covered = 0;
  let r = 0;
  let c = 0;
  let previousEnd = null;
  const delta = (left, right, time) => {
    const a = pointAt(left.a, left.b, time);
    const b = pointAt(right.a, right.b, time);
    return { t: time, thrust: b.thrust - a.thrust, pressure: b.pressure - a.pressure };
  };
  while (r < reference.length && c < candidate.length) {
    const left = reference[r];
    const right = candidate[c];
    const start = Math.max(left.a.t, right.a.t, mappedStart);
    const end = Math.min(left.b.t, right.b.t, mappedEnd);
    if (end > start) {
      const first = delta(left, right, start);
      const last = delta(left, right, end);
      const duration = end - start;
      covered += duration;
      for (const key of KEYS) {
        const a = first[key];
        const b = last[key];
        metrics[key].integral += ((a + b) * duration) / 2;
        metrics[key].absolute += positiveArea(a, b, duration) + positiveArea(-a, -b, duration);
        metrics[key].squared += ((a * a + a * b + b * b) * duration) / 3;
        metrics[key].maxAbs = Math.max(metrics[key].maxAbs, Math.abs(a), Math.abs(b));
      }
      if (previousEnd !== start) points.push({ ...first, gapBefore: previousEnd !== null });
      points.push({ ...last, gapBefore: false });
      previousEnd = end;
    }
    if (left.b.t <= right.b.t) r++;
    else c++;
  }
  if (!(covered > 0)) return null;
  const result = (key) => ({
    bias: metrics[key].integral / covered,
    mae: metrics[key].absolute / covered,
    rmse: Math.sqrt(Math.max(0, metrics[key].squared / covered)),
    maxAbs: metrics[key].maxAbs,
  });
  return {
    thrust: result("thrust"), pressure: result("pressure"),
    coverage: Math.min(1, covered / (mappedEnd - mappedStart)),
    start: mappedStart, end: mappedEnd, duration: mappedEnd - mappedStart,
    points: boundedCurve(points, options.budget ?? CURVE_BUDGET),
  };
}
