import { inspectCSV, TIME_COLUMNS } from "./csv-format.js";
import { t } from "./i18n.js";

const PREVIEW_BYTES = 128 * 1024;
let queue = Promise.resolve();

/** Configure a local CSV without reading or retaining the entire source file. */
export function configureCSV(file, settings = {}, { force = false } = {}) {
  const request = queue.then(() => configure(file, settings, force));
  queue = request.catch(() => {});
  return request;
}

async function configure(file, settings, force) {
  const text = await file.slice(0, PREVIEW_BYTES).text();
  let hasHeader = settings.hasHeader !== false;
  let inspected = inspectCSV(text, { hasHeader, maxRows: 5 });
  if (!force && settings.columns) return { ...settings };
  const automaticTime = inspected.automatic && TIME_COLUMNS[inspected.headers[inspected.automatic.thrustTime].toLowerCase().trim()];
  const timeResolved = settings.timeUnit && settings.timeUnit !== "auto" || automaticTime;
  if (!force && hasHeader && inspected.automatic && timeResolved)
    return {
      ...settings,
      hasHeader: true,
      allowSparse: settings.allowSparse ?? false,
      columns: inspected.automatic,
    };

  const dialog = document.getElementById("csv-mapping-dialog");
  const form = document.getElementById("csv-mapping-form");
  const get = (name) => document.getElementById(`csv-map-${name}`);
  const controls = {
    thrustTime: get("thrust-time"),
    thrust: get("thrust"),
    pressureTime: get("pressure-time"),
    pressure: get("pressure"),
    active: get("active"),
    start: get("start"),
    end: get("end"),
  };
  const initial = settings.columns || inspected.automatic || {
    thrustTime: 0,
    thrust: 1,
    pressureTime: null,
    pressure: null,
    markerMode: "none",
    active: null,
    start: null,
    end: null,
  };
  const columnValues = { ...initial };
  get("filename").textContent = file.name;
  get("header").checked = hasHeader;
  get("sparse").checked = settings.allowSparse ?? !inspected.automatic;
  get("time-unit").value = settings.timeUnit || "auto";
  get("pressure-time-unit").value = settings.pressureTimeUnit === "same" && initial.pressureTime == null
    ? "auto"
    : settings.pressureTimeUnit || "auto";
  get("thrust-unit").value = settings.thrustUnit || "kgf";
  get("pressure-unit").value = settings.pressureUnit || "bar";
  get("marker-mode").value = initial.markerMode || "none";
  get("error").hidden = true;

  function renderColumns() {
    for (const [name, select] of Object.entries(controls)) {
      select.replaceChildren();
      if (name === "pressureTime")
        select.add(new Option(t("Same as thrust time"), ""));
      else if (name === "pressure" || ["active", "start", "end"].includes(name))
        select.add(new Option(t("Not used"), ""));
      else select.add(new Option(t("Choose a column"), ""));
      inspected.headers.forEach((header, index) => {
        const label = hasHeader ? header : t("Column {number}", { number: index + 1 });
        select.add(new Option(`${index + 1} · ${label}`, String(index)));
      });
      const value = columnValues[name];
      select.value = Number.isInteger(value) && value >= 0 && value < inspected.headers.length
        ? String(value)
        : "";
    }
    renderPreview();
  }

  function renderPreview() {
    const head = document.createElement("tr");
    const rowLabel = document.createElement("th");
    rowLabel.scope = "col";
    rowLabel.textContent = t("Line");
    head.append(rowLabel);
    inspected.headers.forEach((header, index) => {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = `${index + 1} · ${hasHeader ? header : t("Column {number}", { number: index + 1 })}`;
      head.append(cell);
    });
    get("preview-head").replaceChildren(head);
    const rows = inspected.rows.slice(0, 5).map((row) => {
      const tr = document.createElement("tr");
      const line = document.createElement("th");
      line.scope = "row";
      line.textContent = String(row.line);
      tr.append(line);
      inspected.headers.forEach((_, index) => {
        const cell = document.createElement("td");
        cell.textContent = row.values[index] ?? "";
        tr.append(cell);
      });
      return tr;
    });
    get("preview-body").replaceChildren(...rows);
  }

  function updateFields() {
    const pressure = controls.pressure.value !== "";
    controls.pressureTime.disabled = !pressure;
    get("pressure-unit").disabled = !pressure;
    get("pressure-time-unit").disabled = !pressure || controls.pressureTime.value === "";
    const mode = get("marker-mode").value;
    get("active-field").hidden = mode !== "active";
    get("event-fields").hidden = mode !== "events";
    get("marker-note").hidden = mode === "none";
  }

  function readColumn(control) {
    return control.value === "" ? null : Number(control.value);
  }

  function values() {
    const pressure = readColumn(controls.pressure);
    const markerMode = get("marker-mode").value;
    return {
      ...settings,
      hasHeader,
      allowSparse: get("sparse").checked,
      timeUnit: get("time-unit").value,
      pressureTimeUnit: pressure === null || controls.pressureTime.value === ""
        ? "same"
        : get("pressure-time-unit").value,
      thrustUnit: get("thrust-unit").value,
      pressureUnit: get("pressure-unit").value,
      columns: {
        thrustTime: readColumn(controls.thrustTime),
        thrust: readColumn(controls.thrust),
        pressureTime: pressure === null ? null : readColumn(controls.pressureTime),
        pressure,
        markerMode,
        active: markerMode === "active" ? readColumn(controls.active) : null,
        start: markerMode === "events" ? readColumn(controls.start) : null,
        end: markerMode === "events" ? readColumn(controls.end) : null,
      },
    };
  }

  function validate(result) {
    const columns = result.columns;
    if (columns.thrustTime === null || columns.thrust === null)
      return "Choose the time and thrust columns.";
    if (columns.thrustTime === columns.thrust)
      return "Time and thrust must use different columns.";
    const namedTimeUnit = (column) => TIME_COLUMNS[inspected.headers[column]?.toLowerCase().trim()];
    if (result.timeUnit === "auto" && !namedTimeUnit(columns.thrustTime))
      return "Select the thrust time unit.";
    if (columns.pressure !== null && columns.pressure === (columns.pressureTime ?? columns.thrustTime))
      return "Time and pressure must use different columns.";
    if (columns.pressure !== null && columns.pressureTime !== null && result.pressureTimeUnit === "auto" && !namedTimeUnit(columns.pressureTime))
      return "Select the pressure time unit.";
    if (columns.markerMode === "active" && columns.active === null)
      return "Choose the active-state column.";
    if (columns.markerMode === "events" && (columns.start === null || columns.end === null))
      return "Choose the start and end flag columns.";
    if (columns.markerMode === "events" && columns.start === columns.end)
      return "Start and end flags must use different columns.";
    if (!inspected.rows.length) return "The preview contains no data rows.";
    return null;
  }

  renderColumns();
  updateFields();
  const abort = new AbortController();
  const options = { signal: abort.signal };
  return new Promise((resolve) => {
    let finished = false;
    function finish(result) {
      if (finished) return;
      finished = true;
      abort.abort();
      dialog.close();
      resolve(result);
    }
    get("close").addEventListener("click", () => finish(null), options);
    get("cancel").addEventListener("click", () => finish(null), options);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    }, options);
    dialog.addEventListener("close", () => finish(null), options);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const result = values();
      const error = validate(result);
      get("error").hidden = !error;
      if (error) {
        get("error").textContent = t(error);
        get("error").focus();
      } else finish(result);
    }, options);
    form.addEventListener("change", () => {
      for (const [name, control] of Object.entries(controls))
        columnValues[name] = readColumn(control);
      get("error").hidden = true;
      updateFields();
    }, options);
    get("header").addEventListener("change", () => {
      hasHeader = get("header").checked;
      inspected = inspectCSV(text, { hasHeader, maxRows: 5 });
      renderColumns();
      updateFields();
    }, options);
    document.addEventListener("flamesync:language", () => {
      for (const [name, control] of Object.entries(controls))
        columnValues[name] = readColumn(control);
      renderColumns();
      get("error").hidden = true;
    }, options);
    dialog.showModal();
  });
}
