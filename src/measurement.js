// @ts-check
import { UserError, message } from "./messages.js";
import { finiteAnalysis, linearFraction, linearValue } from "./signal-math.js";

/** @typedef {{start:number|null,end:number|null,threshold:number,periods:number,warnings:import("./messages.js").Message[]}} DetectedBurn */
/** @param {import('./data.js').BurnData} data @param {number} percent @returns {DetectedBurn} */
export function detectBurnInterval(data, percent = 5) {
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100)
    throw new UserError(
      "Detection threshold must be greater than 0% and less than 100%.",
    );
  const threshold = data.peakThrust * (percent / 100);
  if (data.events) {
    const warnings = [];
    if (data.events.start === null) warnings.push(message("No ignition indicator was found. Set A manually."));
    if (data.events.end === null) warnings.push(message("No burnout indicator was found. Set B manually."));
    if (data.events.periods > 1) warnings.push(message("Multiple thrust periods: the interval spans the first rise to the final decay, including pauses."));
    return { start: data.events.start, end: data.events.end, threshold, periods: data.events.periods, warnings };
  }
  const points = data.points;
  if (data.peakThrust <= 0)
    return {
      start: null,
      end: null,
      threshold,
      periods: 0,
      warnings: [
        message("No positive thrust was found. Set A and B manually."),
      ],
    };
  const first = points.findIndex((point) => point.thrust >= threshold);
  let last = points.length - 1;
  while (last >= 0 && points[last].thrust < threshold) last--;
  /** @param {import('./data.js').ThrustPoint} a @param {import('./data.js').ThrustPoint} b */
  const crossing = (a, b) =>
    linearValue(a.t, b.t, linearFraction(a.thrust, b.thrust, threshold));
  const riseA = points[first - 1],
    riseB = points[first];
  const fallA = points[last],
    fallB = points[last + 1];
  const start = riseA && !riseB.gapBefore ? crossing(riseA, riseB) : null;
  const end = fallB && !fallB.gapBefore ? crossing(fallA, fallB) : null;
  let periods = 0;
  for (let i = 0; i < points.length; i++) {
    if (
      points[i].thrust >= threshold &&
      (i === 0 || points[i - 1].thrust < threshold)
    )
      periods++;
  }
  const warnings = [];
  if (start === null)
    warnings.push(
      message(
        first === 0
          ? "Thrust is already above the threshold at the start of the log. Set A manually."
          : "The thrust rise crosses a data gap. Set A manually.",
      ),
    );
  if (end === null)
    warnings.push(
      message(
        last === points.length - 1
          ? "The thrust has not fallen below the threshold before the log ends. Set B manually."
          : "The thrust decay crosses a data gap. Set B manually.",
      ),
    );
  if (periods > 1)
    warnings.push(
      message(
        "Multiple thrust periods: the interval spans the first rise to the final decay, including pauses.",
      ),
    );
  return { start, end, threshold, periods, warnings };
}

/** @param {import('./data.js').BurnData} data @param {number} start @param {number} end @param {number} timeScale */
export function intervalStats(data, start, end, timeScale = 1) {
  if (
    ![start, end, timeScale].every(Number.isFinite) ||
    start < data.start ||
    end > data.end ||
    end <= start ||
    timeScale <= 0
  )
    throw new UserError(
      "Choose A before B, with both markers inside the CSV time range.",
    );
  let gaps = 0;
  for (let i = 1; i < data.points.length; i++) {
    const a = data.points[i - 1],
      b = data.points[i];
    if (b.gapBefore && a.t < end && b.t > start) gaps++;
  }
  return {
    csvDuration: end - start,
    videoDuration: finiteAnalysis((end - start) * timeScale),
    gaps,
  };
}

/** @param {import('./data.js').BurnData} data @param {number} time @param {number} direction */
export function adjacentTelemetryTime(data, time, direction) {
  const points = data.points;
  let lo = 0,
    hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const before =
      direction > 0
        ? points[mid].t <= time + 1e-9
        : points[mid].t < time - 1e-9;
    if (before) lo = mid + 1;
    else hi = mid;
  }
  return points[
    Math.max(0, Math.min(points.length - 1, direction > 0 ? lo : lo - 1))
  ].t;
}
