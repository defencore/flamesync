import { message } from "../messages.js";
import { profileMapping } from "./model.js";
import { signalPoints } from "../data.js";
import { mergeSignalCurves } from "../signal-curves.js";

export const SERIES_METRICS = [
  "duration", "impulse", "meanThrust", "peakThrust", "meanPressure", "peakPressure",
  "noiseThrustRms", "noisePressureRms", "noiseThrustPercent", "specificImpulse",
];
const MAX_CURVE_POINTS = 2400;
const finite = (value) => typeof value === "number" && Number.isFinite(value);

// R7 quantiles: linearly interpolate sorted observations at h = (n - 1) p.
// This convention is explicit because small-sample quartiles are not unique.
function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position), fraction = position - lower;
  return sorted[lower] + fraction * (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]);
}

function meanAndSd(values) {
  const n = values.length;
  if (!n) return { mean: null, sd: null };
  // Center before summing to retain small variation on a large baseline.
  const origin = values[0];
  let sum = 0, compensation = 0;
  for (const value of values) {
    const corrected = (value - origin) - compensation;
    const next = sum + corrected;
    compensation = (next - sum) - corrected;
    sum = next;
  }
  const mean = origin + sum / n;
  let squares = 0;
  for (const value of values) squares += (value - mean) ** 2;
  return { mean, sd: n > 1 ? Math.sqrt(squares / (n - 1)) : null };
}

function summarize(observations) {
  const values = observations.map(({ value }) => value);
  const sorted = values.toSorted((a, b) => a - b);
  const n = values.length;
  const { mean, sd } = meanAndSd(values);
  const scale = n ? Math.max(Math.abs(sorted[0]), Math.abs(sorted.at(-1))) : 0;
  const relativeAvailable = finite(mean) && Math.abs(mean) > scale * 1e-12;
  let outlierIds = [];
  if (n >= 5) {
    const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1, lower = q1 - 1.5 * iqr, upper = q3 + 1.5 * iqr;
    // Repeated integrals at unequal sampling rates can differ by a few ulps.
    // Scale from the central fences so a very large extreme cannot hide a
    // smaller genuine deviation by inflating the roundoff allowance.
    const tolerance = 1e-12 * Math.max(Math.abs(q1), Math.abs(q3), Math.abs(lower), Math.abs(upper));
    // Flags invite review; they never remove a test from the population.
    outlierIds = observations.filter(({ value }) => value < lower - tolerance || value > upper + tolerance).map(({ id }) => id);
  }
  return {
    n, mean, sd,
    cv: n > 1 && relativeAvailable ? 100 * sd / Math.abs(mean) : null,
    min: n ? sorted[0] : null, max: n ? sorted.at(-1) : null,
    median: n ? quantile(sorted, 0.5) : null,
    outlierIds,
    relativeAvailable,
  };
}

function eligibleReason(entry) {
  const { data, stats } = entry;
  if (!data?.points?.length)
    return message("Raw measurements are unavailable for this test.");
  if (!stats)
    return message("Correct invalid test settings to include it in series statistics.");
  if (![stats.start, stats.end, stats.duration].every(finite) || stats.end <= stats.start || stats.duration <= 0 ||
      stats.start < data.start || stats.end > data.end)
    return message("Set valid ignition and burnout events to include this test in series statistics.");
  if (!finite(stats.coverage) || stats.coverage < 1 - 1e-10)
    return message("Missing data in the selected burn excludes this test from series statistics.");
  return null;
}

function lowerIndex(points, time) {
  let low = 0, high = points.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (points[middle].t <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}

// A small heap merges original knot clocks without allocating a union of logs.
function push(heap, item) {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap[parent].t <= item.t) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = item;
}
function pop(heap) {
  const first = heap[0], last = heap.pop();
  if (heap.length) {
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && heap[child + 1].t < heap[child].t) child++;
      if (last.t <= heap[child].t) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
  }
  return first;
}

function sample(cursor, x, key) {
  const { entry, mapping, points } = cursor;
  cursor.crossedGap = false;
  let time = (x - mapping.offset) / mapping.scale;
  const tolerance = Number.EPSILON * 16 * Math.max(1, Math.abs(time), Math.abs(entry.stats.start), Math.abs(entry.stats.end));
  if (time < entry.stats.start && entry.stats.start - time <= tolerance) time = entry.stats.start;
  if (time > entry.stats.end && time - entry.stats.end <= tolerance) time = entry.stats.end;
  if (time < entry.stats.start || time > entry.stats.end) return null;
  if (time < points[0].t && points[0].t - time <= tolerance) time = points[0].t;
  if (time > points.at(-1).t && time - points.at(-1).t <= tolerance) time = points.at(-1).t;
  while (cursor.sampleIndex + 1 < points.length && points[cursor.sampleIndex + 1].t <= time) {
    cursor.sampleIndex++;
    cursor.crossedGap ||= !!points[cursor.sampleIndex].gapBefore;
  }
  const a = points[cursor.sampleIndex], b = points[cursor.sampleIndex + 1];
  if (time === a.t) return a[key];
  if (!b || b.gapBefore || time < a.t || time > b.t) return null;
  return a[key] + (b[key] - a[key]) * ((time - a.t) / (b.t - a.t));
}

function commonSignalCurve(entries, alignment, limit, key, start, end) {
  const cursors = entries.map((entry) => ({ entry, points: signalPoints(entry.data, key), mapping: profileMapping(entry.stats, alignment), sampleIndex: 0 }))
    .filter(({ points }) => points.length >= 2);
  if (!cursors.length || cursors.some(({ mapping }) => !mapping)) return [];
  const mapped = (cursor, time) => cursor.mapping.offset + time * cursor.mapping.scale;
  // Only tests with this channel contribute. Its own native range clips the
  // common curve without shrinking or suppressing the other channel.
  start = Math.max(start, ...cursors.map((cursor) => cursor.points[0].t > cursor.entry.stats.start ? mapped(cursor, cursor.points[0].t) : start));
  end = Math.min(end, ...cursors.map((cursor) => cursor.points.at(-1).t < cursor.entry.stats.end ? mapped(cursor, cursor.points.at(-1).t) : end));
  if (!(end > start)) return [];
  const displayKeys = [key, `${key}Sd`, `${key}Min`, `${key}Max`];
  const bucketCount = Math.max(1, Math.floor(limit / (2 + displayKeys.length * 2)));
  const buckets = new Map(), heap = [];
  for (let i = 0; i < cursors.length; i++) {
    const cursor = cursors[i], sourceStart = (start - cursor.mapping.offset) / cursor.mapping.scale;
    cursor.sampleIndex = lowerIndex(cursor.points, sourceStart);
    let index = cursor.sampleIndex;
    while (index < cursor.points.length && mapped(cursor, cursor.points[index].t) < start) index++;
    if (index < cursor.points.length && mapped(cursor, cursor.points[index].t) <= end)
      push(heap, { t: mapped(cursor, cursor.points[index].t), cursor: i, index });
  }
  // Native knots protect extrema; the extra grid only smooths display bands.
  const gridCount = Math.max(2, Math.min(limit, 800));
  let grid = 0, previousTime = null, breakPending = false;
  while (grid <= gridCount || heap.length) {
    const gridTime = grid <= gridCount ? (grid === gridCount ? end : start + (end - start) * grid / gridCount) : Infinity;
    const time = Math.min(gridTime, heap[0]?.t ?? Infinity);
    if (!finite(time) || time > end) break;
    if (gridTime === time) grid++;
    while (heap.length && heap[0].t === time) {
      const item = pop(heap), cursor = cursors[item.cursor];
      const index = item.index + 1, point = cursor.points[index];
      if (point) {
        const t = mapped(cursor, point.t);
        if (t <= end) push(heap, { t, cursor: item.cursor, index });
      }
    }
    if (time === previousTime) continue;
    previousTime = time;
    const values = cursors.map((cursor) => sample(cursor, time, key));
    if (values.some((value) => !finite(value))) { breakPending = true; continue; }
    breakPending ||= cursors.some((cursor) => cursor.crossedGap);
    const stats = meanAndSd(values);
    const point = { t: time, [key]: stats.mean, [`${key}Sd`]: stats.sd,
      [`${key}Min`]: Math.min(...values), [`${key}Max`]: Math.max(...values),
      [`${key}N`]: cursors.length, gapBefore: breakPending };
    breakPending = false;
    const bucketIndex = Math.min(bucketCount - 1, Math.floor((time - start) / (end - start) * bucketCount));
    let bucket = buckets.get(bucketIndex);
    if (!bucket) {
      bucket = { first: point, last: point, extrema: Object.fromEntries(displayKeys.map((name) => [name, { min: point, max: point }])) };
      buckets.set(bucketIndex, bucket);
    }
    bucket.last = point;
    for (const name of displayKeys) {
      if (!finite(point[name])) continue;
      if (point[name] < bucket.extrema[name].min[name]) bucket.extrema[name].min = point;
      if (point[name] > bucket.extrema[name].max[name]) bucket.extrema[name].max = point;
    }
    bucket.hasGap ||= point.gapBefore;
  }
  const points = [];
  for (const bucket of buckets.values()) {
    const selected = new Set([bucket.first, bucket.last]);
    for (const extrema of Object.values(bucket.extrema)) selected.add(extrema.min).add(extrema.max);
    const ordered = [...selected].sort((a, b) => a.t - b.t);
    if (bucket.hasGap && ordered.length) ordered[0] = { ...ordered[0], gapBefore: true };
    points.push(...ordered);
  }
  return points;
}

function commonCurve(entries, alignment, requestedBudget) {
  if (!entries.length) return null;
  const cursors = entries.map((entry) => ({ entry, mapping: profileMapping(entry.stats, alignment) }));
  if (cursors.some(({ mapping }) => !mapping)) return null;
  const mapped = (cursor, time) => cursor.mapping.offset + time * cursor.mapping.scale;
  // Normalized endpoints are exact despite large absolute logger clocks.
  const start = alignment === "normalized" ? 0 : Math.max(...cursors.map((cursor) => mapped(cursor, cursor.entry.stats.start)));
  const end = alignment === "normalized" ? 100 : Math.min(...cursors.map((cursor) => mapped(cursor, cursor.entry.stats.end)));
  if (!(end > start)) return null;
  const limit = finite(requestedBudget) ? Math.min(MAX_CURVE_POINTS, Math.max(20, Math.floor(requestedBudget))) : 800;
  const thrust = commonSignalCurve(entries, alignment, Math.floor(limit / 2), "thrust", start, end);
  const pressure = commonSignalCurve(entries, alignment, Math.floor(limit / 2), "pressure", start, end);
  const points = mergeSignalCurves(thrust, pressure);
  return points.length ? { points, start, end, count: entries.length } : null;
}

/** Every eligible test has equal weight, irrespective of logger sample rate.
 * Scalar metrics retain original seconds. The bounded curve is for display;
 * its sample SD is test-to-test spread, not a confidence or tolerance interval. */
export function analyseSeries(entries, options = {}) {
  const alignment = options.alignment ?? "ignition";
  const included = entries.filter((entry) => entry.included !== false);
  const eligible = [], excluded = [];
  for (const entry of included) {
    const reason = eligibleReason(entry);
    if (reason) excluded.push({ id: entry.id, reason });
    else eligible.push(entry);
  }
  const metrics = {}, privateMetrics = {};
  for (const key of SERIES_METRICS) {
    const summary = summarize(eligible.filter((entry) => finite(entry.stats[key])).map((entry) => ({ id: entry.id, value: entry.stats[key] })));
    const { relativeAvailable, ...publicSummary } = summary;
    privateMetrics[key] = summary;
    metrics[key] = publicSummary;
  }
  const deviations = eligible.map((entry) => ({
    id: entry.id,
    metrics: Object.fromEntries(SERIES_METRICS.map((key) => {
      const value = finite(entry.stats[key]) ? entry.stats[key] : null;
      const summary = privateMetrics[key];
      const delta = value === null || summary.mean === null ? null : value - summary.mean;
      return [key, { value, delta,
        percent: delta !== null && summary.relativeAvailable ? 100 * delta / Math.abs(summary.mean) : null,
        z: delta !== null && finite(summary.sd) && summary.sd > 0 ? delta / summary.sd : null,
        outlier: value !== null && summary.outlierIds.includes(entry.id),
      }];
    })),
  }));
  return {
    includedCount: included.length, eligibleCount: eligible.length,
    eligibleIds: eligible.map(({ id }) => id), excluded, metrics, deviations,
    curve: commonCurve(eligible, alignment, options.budget), alignment,
  };
}
