// @ts-check
import { linearFraction } from "./signal-math.js";

/** @param {number} value */
export function niceStep(value) {
  if (!(value > 0)) return 1;
  const bounded = Math.min(Number.MAX_VALUE, value);
  const magnitude = 10 ** Math.floor(Math.log10(bounded)) || Number.MIN_VALUE;
  const factor = [1, 2, 2.5, 5, 10].find((candidate) => candidate >= bounded / magnitude) ?? 10;
  return Math.min(Number.MAX_VALUE, factor * magnitude);
}

/** Rounded sensor bounds with bounded ticks, including very large finite signals.
 * @param {number} minimum
 * @param {number} maximum
 * @param {{intervals?:number,padding?:number,padNegative?:boolean}} options
 */
export function valueAxis(minimum, maximum, { intervals = 2, padding = 0.06, padNegative = false } = {}) {
  const low = Math.min(0, Number.isFinite(minimum) ? minimum : 0);
  const high = Math.max(0, Number.isFinite(maximum) ? maximum : 0);
  const scale = Math.max(Math.abs(low), Math.abs(high)) || 1;
  const normalizedLow = low / scale, normalizedHigh = high / scale;
  const span = normalizedHigh - normalizedLow || 1;
  const paddedLow = padNegative && low < 0 ? normalizedLow - span * padding : normalizedLow;
  const paddedHigh = high > 0 ? normalizedHigh + (padNegative ? span : normalizedHigh) * padding : normalizedHigh;
  const rough = (padNegative ? paddedHigh - paddedLow || 1 : span * (1 + padding)) / intervals;
  const step = niceStep(Math.max(Number.MIN_VALUE, rough * scale)), normalizedStep = step / scale;
  const first = Math.floor(paddedLow / normalizedStep) * normalizedStep;
  const last = Math.max(first + normalizedStep, Math.ceil(paddedHigh / normalizedStep) * normalizedStep);
  const finite = (/** @type {number} */ value) => Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, value * scale)) || 0;
  const min = finite(first), max = finite(last);
  const ticks = [min];
  const count = Math.min(100, Math.round((last - first) / normalizedStep));
  for (let index = 1; index < count; index++) {
    const tick = finite(first + normalizedStep * index);
    if (tick > ticks[ticks.length - 1] && tick < max) ticks.push(tick);
  }
  ticks.push(max);
  return { min, max, step, ticks };
}

/** @param {number} value @param {{min:number,max:number}} axis */
export const axisFraction = (value, axis) => linearFraction(axis.min, axis.max, value);
