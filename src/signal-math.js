// @ts-check
import { UserError } from "./messages.js";

/** Reject unrepresentable derived quantities before they reach a chart or report.
 * @param {number} value */
export function finiteAnalysis(value) {
  if (!Number.isFinite(value))
    throw new UserError("The analysis exceeds the supported numeric range. Check the values, units, and timestamps.");
  return value;
}

/** Interpolate a bounded segment without overflowing the difference of finite
 * endpoints with opposite signs. Preserve exact endpoints and small changes
 * on a large common baseline.
 * @param {number} a @param {number} b @param {number} fraction */
export function linearValue(a, b, fraction) {
  if (fraction === 0 || a === b) return a;
  if (fraction === 1) return b;
  return Math.sign(a) === Math.sign(b)
    ? a + (b - a) * fraction
    : a * (1 - fraction) + b * fraction;
}

/** Locate a value between two finite, unequal endpoints.
 * @param {number} a @param {number} b @param {number} value */
export function linearFraction(a, b, value) {
  const delta = b - a, position = value - a;
  if (Number.isFinite(delta) && Number.isFinite(position)) return position / delta;
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(value));
  return (value / scale - a / scale) / (b / scale - a / scale);
}

/** Exact positive area under a linear sensor segment, including zero crossings.
 * @param {number} a @param {number} b @param {number} duration */
export function positiveArea(a, b, duration) {
  if (a >= 0 && b >= 0) return linearValue(a, b, 0.5) * duration;
  if (a <= 0 && b <= 0) return 0;
  const positive = Math.max(a, b), negative = -Math.min(a, b);
  const fraction = positive >= negative ? 1 / (1 + negative / positive)
    : (positive / negative) / (1 + positive / negative);
  return (positive / 2) * (duration * fraction);
}

/** Exact RMS of a linear segment, with normalization before squaring.
 * @param {number} a @param {number} b */
export function linearRms(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return 0;
  const first = a / scale, last = b / scale;
  return scale * Math.sqrt((first * first + first * last + last * last) / 3);
}

/** Merge disjoint continuous-time moments without squaring physical values.
 * @param {{weight:number,mean:number,rms:number}} totals
 * @param {number} weight @param {number} mean @param {number} rms */
export function addWeightedMoments(totals, weight, mean, rms) {
  if (!(weight > 0)) return;
  const nextWeight = totals.weight + weight;
  const fraction = weight / nextWeight;
  totals.mean = linearValue(totals.mean, mean, fraction);
  totals.rms = Math.hypot(totals.rms * Math.sqrt(totals.weight / nextWeight), rms * Math.sqrt(fraction));
  totals.weight = nextWeight;
}
