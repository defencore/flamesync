import { linearValue } from "./signal-math.js";

const finite = Number.isFinite;

/** Reduce one native clock for display, retaining extrema and missing spans. */
export function reduceSignal(points, key, budget = 2400) {
  const limit = Math.max(4, Math.floor(budget));
  const indices = [];
  if (points.length <= limit) {
    for (let i = 0; i < points.length; i++) indices.push(i);
  } else {
    const groups = Math.max(1, Math.floor(limit / 4));
    const stride = Math.ceil(points.length / groups);
    for (let start = 0; start < points.length; start += stride) {
      const end = Math.min(points.length, start + stride);
      let minimum = start, maximum = start;
      for (let i = start + 1; i < end; i++) {
        if (points[i][key] < points[minimum][key]) minimum = i;
        if (points[i][key] > points[maximum][key]) maximum = i;
      }
      indices.push(...[...new Set([start, minimum, maximum, end - 1])].sort((a, b) => a - b));
    }
  }
  let previous = -1;
  return indices.map((index) => {
    let gapBefore = false;
    for (let i = previous + 1; i <= index; i++) gapBefore ||= !!points[i].gapBefore;
    previous = index;
    return { ...points[index], gapBefore };
  });
}

/** Join display knots only. Statistical calculations always use native data. */
export function mergeSignalCurves(thrustPoints, pressurePoints) {
  const channels = [{ key: "thrust", points: thrustPoints }, { key: "pressure", points: pressurePoints }];
  const indices = [0, 0], cursors = [0, 0], output = [];
  const previousAvailable = [false, false];
  while (indices[0] < thrustPoints.length || indices[1] < pressurePoints.length) {
    const time = Math.min(thrustPoints[indices[0]]?.t ?? Infinity, pressurePoints[indices[1]]?.t ?? Infinity);
    const joined = { t: time, thrust: null, pressure: null, thrustGapBefore: true, pressureGapBefore: true };
    for (let channel = 0; channel < channels.length; channel++) {
      const { key, points } = channels[channel];
      while (indices[channel] < points.length && points[indices[channel]].t === time) indices[channel]++;
      while (cursors[channel] + 1 < points.length && points[cursors[channel] + 1].t <= time) cursors[channel]++;
      const a = points[cursors[channel]], b = points[cursors[channel] + 1];
      const exact = a?.t === time;
      const available = exact ? finite(a[key]) : a && b && !b.gapBefore && time > a.t && time < b.t;
      if (available) {
        joined[key] = exact ? a[key] : linearValue(a[key], b[key], (time - a.t) / (b.t - a.t));
        joined[`${key}GapBefore`] = output.length > 0 && (!previousAvailable[channel] || (exact && !!a.gapBefore));
        for (const suffix of ["Sd", "Min", "Max", "N"]) {
          const field = `${key}${suffix}`;
          if (field in a) joined[field] = exact ? a[field] :
            finite(a[field]) && finite(b[field]) ? linearValue(a[field], b[field], (time - a.t) / (b.t - a.t)) : null;
        }
      }
      previousAvailable[channel] = !!available;
    }
    joined.gapBefore = joined.thrustGapBefore && joined.pressureGapBefore;
    if (finite(joined.thrustN) || finite(joined.pressureN)) joined.n = joined.thrustN ?? joined.pressureN;
    output.push(joined);
  }
  return output;
}
