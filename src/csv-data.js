import { UserError, message } from "./messages.js";
import { timeFactor, thrustFactor, pressureFactor } from "./units.js";
import { csvTable, resolveColumns, columnTimeUnit, csvNumber } from "./csv-format.js";
import { linearFraction, linearValue, positiveArea } from "./signal-math.js";

function channel(points, key) {
  const intervals = [];
  const stride = Math.max(1, Math.ceil((points.length - 1) / 4096));
  for (let index = 1; index < points.length; index += stride) intervals.push(points[index].t - points[index - 1].t);
  intervals.sort((a, b) => a - b);
  const gapLimit = Math.max(0.5, (intervals[Math.floor(intervals.length / 2)] ?? 0) * 3);
  let gaps = 0, peak = 0, minimum = 0, impulse = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index], previous = points[index - 1];
    point.gapBefore = Boolean(previous && point.t - previous.t > gapLimit);
    if (point.gapBefore) gaps++;
    if (key === "thrust") {
      if (previous && !point.gapBefore) impulse += positiveArea(previous.thrust, point.thrust, point.t - previous.t);
      if (!Number.isFinite(impulse)) throw new UserError("Line {value0}: converted values exceed the supported numeric range.", { value0: point.line });
      point.impulse = impulse;
    }
    peak = Math.max(peak, point[key]); minimum = Math.min(minimum, point[key]);
    point[key === "thrust" ? "maxThrustSoFar" : "maxPressureSoFar"] = peak;
  }
  return { start: points[0]?.t ?? null, end: points.at(-1)?.t ?? null,
    duration: points.length ? points.at(-1).t - points[0].t : 0,
    count: points.length, gaps, gapLimit, peak: points.length ? peak : null,
    minimum: points.length ? minimum : null, impulse };
}

function burnEvents(rows, table, columns, timeScale) {
  if (columns.markerMode === "none") return null;
  let start = null, end = null, active = false, periods = 0;
  const flag = (value, line) => {
    if (value === "") return null;
    if (/^(?:1|true)$/i.test(value)) return true;
    if (/^(?:0|false)$/i.test(value)) return false;
    throw new UserError("Line {value0}: burn indicators must be 0, 1, true, or false.", { value0: line });
  };
  let previousStart = false, previousEnd = false;
  for (const row of rows) {
    const state = columns.markerMode === "active" ? flag(row.values[columns.active], row.line) : null;
    const rise = columns.markerMode === "events" ? flag(row.values[columns.start], row.line) : null;
    const fall = columns.markerMode === "events" ? flag(row.values[columns.end], row.line) : null;
    if (state === null && rise === null && fall === null) continue;
    const raw = row.values[columns.thrustTime];
    if (!raw && !(state || rise || fall)) continue;
    const time = csvNumber(raw, table.delimiter) * timeScale;
    if (!Number.isFinite(time) || time < 0) throw new UserError("Line {value0}: a burn indicator needs a valid thrust timestamp.", { value0: row.line });
    if (columns.markerMode === "active") {
      if (state && !active) { start ??= time; periods++; }
      if (!state && active) end = time;
      if (state !== null) active = state;
    } else {
      if (rise && !previousStart) {
        if (start === null && end !== null) throw new UserError("Burnout must follow ignition in the selected indicator columns.");
        start ??= time; end = null; periods++;
      }
      if (fall && !previousEnd) end = time;
      previousStart = rise ?? previousStart; previousEnd = fall ?? previousEnd;
    }
  }
  if (columns.markerMode === "active" && active) end = null;
  if (start !== null && end !== null && end <= start) throw new UserError("Burnout must follow ignition in the selected indicator columns.");
  return { start, end, periods, source: "columns" };
}

export function parseCSV(text, settings = {}) {
  const table = csvTable(text, { hasHeader: settings.hasHeader !== false });
  if (table.rows.length < 2) throw new UserError("The CSV needs a header and at least two samples.");
  const columns = resolveColumns(table.headers, settings);
  const timeUnit = columnTimeUnit(table.headers, columns.thrustTime, settings.timeUnit);
  const pressureTimeColumn = columns.pressureTime ?? columns.thrustTime;
  const pressureTimeUnit = columns.pressure === null ? timeUnit
    : settings.pressureTimeUnit === "same" || pressureTimeColumn === columns.thrustTime
      ? timeUnit : columnTimeUnit(table.headers, pressureTimeColumn, settings.pressureTimeUnit ?? "auto");
  const sourceUnits = { time: timeUnit, pressureTime: pressureTimeUnit, thrust: settings.thrustUnit ?? "N", pressure: settings.pressureUnit ?? "bar" };
  const timeScale = timeFactor(timeUnit), pressureTimeScale = timeFactor(pressureTimeUnit);
  const forceScale = thrustFactor(sourceUnits.thrust), pressureScale = pressureFactor(sourceUnits.pressure);
  const points = [], pressurePoints = [];
  const add = (row, target, timeColumn, valueColumn, key, clockScale, scale) => {
    const rawTime = row.values[timeColumn], rawValue = row.values[valueColumn];
    if (settings.allowSparse && rawValue === "") {
      if (rawTime !== "" && (!Number.isFinite(csvNumber(rawTime, table.delimiter)) || csvNumber(rawTime, table.delimiter) < 0))
        throw new UserError("Line {value0}: every sample must contain finite numeric values in all columns.", { value0: row.line });
      return;
    }
    const raw = csvNumber(rawValue, table.delimiter), clock = csvNumber(rawTime, table.delimiter);
    if (![raw, clock].every(Number.isFinite)) throw new UserError("Line {value0}: every sample must contain finite numeric values in all columns.", { value0: row.line });
    const t = clock * clockScale, value = raw * scale;
    if (![t, value].every(Number.isFinite)) throw new UserError("Line {value0}: converted values exceed the supported numeric range.", { value0: row.line });
    if (t < 0) throw new UserError("Line {value0}: time cannot be negative.", { value0: row.line });
    if (target.length && t <= target.at(-1).t) throw new UserError("Line {value0}: timestamps must increase strictly. Remove duplicate or out-of-order samples.", { value0: row.line });
    target.push({ t, [key]: value, line: row.line, gapBefore: false });
  };
  for (const row of table.rows) {
    if (row.values.length !== table.headers.length) throw new UserError("Line {value0}: every sample must contain finite numeric values in all columns.", { value0: row.line });
    add(row, points, columns.thrustTime, columns.thrust, "thrust", timeScale, forceScale);
    if (columns.pressure !== null) add(row, pressurePoints, pressureTimeColumn, columns.pressure, "pressure", pressureTimeScale, pressureScale);
  }
  if (points.length < 2) throw new UserError("The CSV needs at least two samples.");
  const thrust = channel(points, "thrust"), pressure = channel(pressurePoints, "pressure");
  const events = burnEvents(table.rows, table, columns, timeScale);
  if (events && [events.start, events.end].some((value) => value !== null && (value < thrust.start || value > thrust.end)))
    throw new UserError("Burn indicators must lie inside the thrust time range.");
  const threshold = thrust.peak * 0.05;
  const onset = thrust.peak > 0 ? points.findIndex((point) => point.thrust >= threshold) : -1;
  let ignition = points[0].t;
  if (onset > 0) {
    const a = points[onset - 1], b = points[onset];
    ignition = !b.gapBefore ? linearValue(a.t, b.t, linearFraction(a.thrust, b.thrust, threshold)) : b.t;
  }
  if (events?.start !== null && events?.start !== undefined) ignition = events.start;
  const warnings = [];
  if (thrust.gaps) warnings.push(message("Found {count} data gaps over {limit} s. Missing intervals are not interpolated or integrated.", { count: thrust.gaps, limit: Number(thrust.gapLimit.toFixed(6)) }));
  if (pressure.gaps && (pressureTimeColumn !== columns.thrustTime || pressure.count !== thrust.count))
    warnings.push(message("Pressure contains {count} gaps. Missing pressure intervals are not interpolated.", { count: pressure.gaps }));
  return { sourceUnits, points, pressurePoints, channels: { thrust, pressure },
    start: thrust.start, end: thrust.end, duration: thrust.duration, ignition,
    overallStart: Math.min(thrust.start, pressure.start ?? thrust.start), overallEnd: Math.max(thrust.end, pressure.end ?? thrust.end),
    separateTime: columns.pressure !== null && (pressureTimeColumn !== columns.thrustTime || pressureTimeUnit !== timeUnit || pressure.count !== thrust.count),
    gaps: thrust.gaps, gapLimit: thrust.gapLimit, peakThrust: thrust.peak, minThrust: thrust.minimum,
    peakPressure: pressure.peak, minPressure: pressure.minimum, impulse: thrust.impulse, warnings, events,
    columnMapping: { ...columns }, hasHeader: settings.hasHeader !== false };
}
