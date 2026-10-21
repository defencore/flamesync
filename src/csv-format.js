import { UserError } from "./messages.js";

export const TIME_COLUMNS = Object.freeze({ time_ms: "ms", time_us: "us", time_µs: "us", time_μs: "us", time_s: "s", time: null });

function records(text, limit = Infinity, partial = false) {
  const result = [];
  let quoted = false, comment = false, start = 0, line = 1, firstLine = 1;
  const add = (end) => {
    const value = text.slice(start, end).trim();
    if (value && !value.startsWith("#") && !value.startsWith("//")) result.push({ text: value, line: firstLine });
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (!quoted && !comment && (character === "#" || (character === "/" && text[index + 1] === "/")) && !text.slice(start, index).trim()) comment = true;
    if (!comment && character === '"') {
      if (quoted && text[index + 1] === '"') { index++; continue; }
      quoted = !quoted;
    }
    if (character === "\n") {
      line++;
      if (!quoted) {
        add(index); start = index + 1; firstLine = line; comment = false;
        if (result.length >= limit) return result;
      }
    }
  }
  if (quoted) {
    if (!partial) throw new UserError("Line {value0}: a quoted CSV field is not closed.", { value0: firstLine });
  } else add(text.length);
  return result;
}

function cells(text, delimiter, line = null) {
  const result = [];
  let value = "", quoted = false, closed = false;
  const invalid = () => { throw new UserError("Line {value0}: malformed quoted CSV field.", { value0: line }); };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index++; }
      else {
        if (!quoted && (closed || value.trim()) && line !== null) invalid();
        if (quoted) closed = true;
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) { result.push(value.trim()); value = ""; closed = false; }
    else {
      if (!quoted && closed && character.trim() && line !== null) invalid();
      value += character;
    }
  }
  result.push(value.trim());
  return result;
}

export function csvTable(text, { hasHeader = true, maxRows = Infinity, partial = false } = {}) {
  const source = records(text.replace(/^\uFEFF/, ""), maxRows === Infinity ? Infinity : maxRows + Number(hasHeader), partial);
  if (!source.length) throw new UserError("The CSV is empty.");
  const delimiter = [";", "\t", ","].map((value) => ({ value, count: cells(source[0].text, value).length }))
    .find(({ count }) => count >= 2);
  if (!delimiter) throw new UserError("Use semicolon, comma, or tab separated columns: time_ms;thrust;pressure (or time_us).");
  const first = cells(source[0].text, delimiter.value, source[0].line);
  const headers = hasHeader ? first : first.map((_, index) => `Column ${index + 1}`);
  const rows = source.slice(hasHeader ? 1 : 0).map((record) => ({ values: cells(record.text, delimiter.value, record.line), line: record.line }));
  return { headers, rows, delimiter: delimiter.value };
}

export function automaticColumns(headers) {
  const normalized = headers.map((name) => name.toLowerCase().trim());
  const times = normalized.flatMap((name, index) => Object.hasOwn(TIME_COLUMNS, name) ? [index] : []);
  if (new Set(normalized).size !== normalized.length || times.length !== 1 || !normalized.includes("thrust") || !normalized.includes("pressure")) return null;
  return { thrustTime: times[0], thrust: normalized.indexOf("thrust"), pressureTime: null, pressure: normalized.indexOf("pressure"), markerMode: "none", active: null, start: null, end: null };
}

export function inspectCSV(text, { hasHeader = true } = {}) {
  const table = csvTable(text, { hasHeader, maxRows: 6, partial: true });
  return { ...table, automatic: hasHeader ? automaticColumns(table.headers) : null };
}

export function resolveColumns(headers, settings) {
  const columns = settings.columns ?? (settings.hasHeader !== false ? automaticColumns(headers) : null);
  if (!columns) throw new UserError("Required unique columns: one of time_ms, time_us, time_s, or time; thrust; pressure.");
  const valid = (value) => Number.isInteger(value) && value >= 0 && value < headers.length;
  if (!valid(columns.thrustTime) || !valid(columns.thrust) || columns.thrustTime === columns.thrust)
    throw new UserError("Choose different time and value columns for thrust.");
  if (columns.pressure !== null && (!valid(columns.pressure) || !valid(columns.pressureTime ?? columns.thrustTime) || columns.pressure === (columns.pressureTime ?? columns.thrustTime)))
    throw new UserError("Choose different time and value columns for pressure, or select no pressure.");
  const markerMode = columns.markerMode ?? "none";
  if (!["none", "active", "events"].includes(markerMode)) throw new UserError("Choose a valid burn marker mode.");
  if (markerMode === "active" && !valid(columns.active)) throw new UserError("Choose the active-state column.");
  if (markerMode === "events" && (!valid(columns.start) || !valid(columns.end) || columns.start === columns.end))
    throw new UserError("Choose separate ignition and burnout columns.");
  return { ...columns, markerMode };
}

export function columnTimeUnit(headers, column, selection) {
  const unit = selection && selection !== "auto" ? selection : TIME_COLUMNS[headers[column].toLowerCase().trim()];
  if (!unit) throw new UserError("The time column has no unit. Use time_ms/time_us/time_s, or select its unit in CSV format & units.");
  return unit;
}

export function csvNumber(value, delimiter) {
  const normalized = value?.replace(delimiter === "," ? /$^/ : /,/g, ".");
  return normalized && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized) ? Number(normalized) : NaN;
}
