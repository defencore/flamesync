// @ts-check

/** @typedef {{start:number,end:number,overallStart?:number,overallEnd?:number}} TimeInterval */
/** @typedef {{start?:number|null,end?:number|null}} BurnInterval */
/** @typedef {{data:TimeInterval,stats?:BurnInterval|null,offset:number,timeScale:number,enabled?:boolean}} TheoryTrace */

/** @param {BurnInterval|null|undefined} value @returns {TimeInterval|null} */
function interval(value) {
  const start = value?.start, end = value?.end;
  return typeof start === "number" && typeof end === "number" &&
    Number.isFinite(start) && Number.isFinite(end) && end > start &&
    Number.isFinite(end - start)
    ? { start, end }
    : null;
}

/** A missing burn endpoint does not become an inferred event.
 * @param {TimeInterval} source
 * @param {BurnInterval|null|undefined} burn
 */
function burnInterval(source, burn) {
  const selected = interval(burn);
  return selected && selected.start >= source.start && selected.end <= source.end
    ? selected
    : null;
}

/** Keep the plotting clock in measured CSV seconds. Known burn intervals define
 * the focused view; traces without A/B are clipped to it. With no known burn,
 * show both complete source ranges. Padding is a viewport margin and does not
 * alter events, samples, or timing maps.
 * @param {TimeInterval|null|undefined} data
 * @param {TheoryTrace|null} theory
 * @param {BurnInterval|null} measurement
 * @param {"burn"|"full"} range
 * @returns {{start:number,end:number,duration:number}}
 */
export function overlayTimeDomain(data, theory = null, measurement = null, range = "burn") {
  /** @type {TimeInterval[]} */
  const sources = [];
  /** @type {TimeInterval[]} */
  const burns = [];
  const measuredSource = interval(data);
  if (measuredSource) {
    sources.push(interval({ start: data?.overallStart ?? measuredSource.start, end: data?.overallEnd ?? measuredSource.end }) ?? measuredSource);
    const selected = burnInterval(measuredSource, measurement);
    if (selected) burns.push(selected);
  }

  const theorySource = theory?.enabled !== false ? interval(theory?.data) : null;
  if (theory && theorySource && Number.isFinite(theory.offset) &&
    Number.isFinite(theory.timeScale) && theory.timeScale > 0) {
    /** @param {TimeInterval} source */
    const mapped = (source) => interval({
      start: theory.offset + source.start * theory.timeScale,
      end: theory.offset + source.end * theory.timeScale,
    });
    const mappedSource = mapped({ start: theory.data.overallStart ?? theorySource.start, end: theory.data.overallEnd ?? theorySource.end });
    if (mappedSource) sources.push(mappedSource);
    const selected = burnInterval(theorySource, theory.stats);
    const mappedBurn = selected && mapped(selected);
    if (mappedBurn) burns.push(mappedBurn);
  }

  const focused = range === "burn" && burns.length > 0;
  const intervals = focused ? burns : sources;
  if (!intervals.length) return { start: 0, end: 1, duration: 1 };
  let start = Math.min(...intervals.map((value) => value.start));
  let end = Math.max(...intervals.map((value) => value.end));
  // A clock whose span cannot be represented is not a valid plotting domain.
  if (!Number.isFinite(end - start)) return { start: 0, end: 1, duration: 1 };
  if (focused) {
    const margin = (end - start) * 0.08;
    const padded = interval({ start: start - margin, end: end + margin });
    if (padded) ({ start, end } = padded);
  }
  return { start, end, duration: end - start };
}
