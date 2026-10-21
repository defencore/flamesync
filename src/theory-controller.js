import { $ } from "./dom.js";
import { bindText } from "./i18n.js";
import { errorMessage, message } from "./messages.js";
import { alignTheory, validateTheoryMapping } from "./theory.js";
import { configureCSV } from "./csv-mapping.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const UNIT_FIELDS = [
  ["theory-time-unit", "timeUnit"],
  ["theory-thrust-unit", "thrustUnit"],
  ["theory-pressure-unit", "pressureUnit"],
];
const EVENT_FIELDS = [["theory-start", "start"], ["theory-end", "end"]];
const CONTROL_IDS = [...UNIT_FIELDS.map(([id]) => id),
  ...EVENT_FIELDS.map(([id]) => id), "theory-detect", "theory-alignment",
  "theory-offset", "theory-scale", "theory-columns"];
const precise = (value) => Number.isFinite(value) ? String(Number(value.toFixed(6))) : "";
const userMessage = (error) => error?.userMessage ?? errorMessage(error);
const eventIdentity = (settings) => JSON.stringify([
  settings.timeUnit, settings.hasHeader, settings.allowSparse,
  ...["thrustTime", "thrust", "markerMode", "active", "start", "end"].map((key) => settings.columns?.[key]),
]);

export function createTheoryController({ onChange = () => {}, notice = () => {} } = {}) {
  let file = null, data = null, reduced = [], stats = null;
  let importSettings = Object.fromEntries(UNIT_FIELDS.map(([id, key]) => [key, $(id).value]));
  let settings = { ...importSettings }, options = {};
  let sourceSettings = { ...settings };
  let enabled = $("theory-enabled").checked, loading = false, valid = true;
  let sourceValid = true, timingValid = true, sourceError = null;
  let importMode = $("theory-alignment").value;
  let mode = importMode, offset = 0, scale = 1;
  let statusError = null, sequence = 0, revision = 0, sourceSequence = 0;
  let sourceKey = "", worker = null, disposed = false, currentSnapshot;
  let forceNextImport = false;
  const pending = new Map();

  function stopWorker() {
    worker?.terminate();
    worker = null;
    for (const job of pending.values())
      job.reject(new DOMException("Theoretical analysis cancelled", "AbortError"));
    pending.clear();
  }
  function request(payload) {
    if (!worker) {
      const activeWorker = new Worker(new URL("./theory-worker.js", import.meta.url), { type: "module" });
      worker = activeWorker;
      activeWorker.onmessage = ({ data: response }) => {
        if (worker !== activeWorker) return;
        const job = pending.get(response.requestId);
        if (!job) return;
        pending.delete(response.requestId);
        if (response.error)
          job.reject(Object.assign(new Error(response.error.key), { userMessage: response.error }));
        else job.resolve(response.result);
      };
      activeWorker.onerror = (event) => {
        if (worker !== activeWorker) return;
        const error = new Error(event.message);
        for (const job of pending.values()) job.reject(error);
        pending.clear();
        worker?.terminate();
        worker = null;
      };
    }
    return new Promise((resolve, reject) => {
      const requestId = ++sequence;
      pending.set(requestId, { resolve, reject });
      try { worker.postMessage({ ...payload, requestId }); }
      catch (error) {
        pending.delete(requestId);
        reject(error);
      }
    });
  }
  function updateSnapshot() {
    currentSnapshot = { file, name: file?.name ?? "", data, reduced, stats,
      settings: { ...settings }, importSettings: { ...importSettings },
      enabled, loading, valid, sourceValid, mode, offset, scale };
  }
  function render({ fields = false } = {}) {
    $("theory-panel").setAttribute("aria-busy", String(loading));
    $("theory-panel").classList.toggle("has-error", Boolean(statusError));
    $("theory-name").textContent = file?.name ?? "";
    $("theory-name").title = file?.name ?? "";
    $("theory-remove").disabled = !file && !loading;
    for (const id of CONTROL_IDS) $(id).disabled = loading || (!file && ["theory-start", "theory-end", "theory-detect"].includes(id));
    if (fields) {
      $("theory-alignment").value = mode;
      for (const [id, key] of UNIT_FIELDS) $(id).value = settings[key];
      for (const [id, key] of EVENT_FIELDS) {
        $(id).value = precise(stats?.[key]);
        if (data) {
          $(id).min = precise(data.start);
          $(id).max = precise(data.end);
        } else {
          $(id).removeAttribute("min");
          $(id).removeAttribute("max");
        }
      }
    }
    const status = statusError ?? (loading
      ? message("Reading theoretical CSV…")
      : !file
        ? message("Optional: compare measurements with a calculation or simulation. Files stay on your device.")
        : !enabled
          ? message("Theoretical profile loaded. Enable Show theory to include it.")
          : !Number.isFinite(stats?.start) || !Number.isFinite(stats?.end)
            ? message("Set theoretical ignition A and burnout B, or use original CSV time.")
            : message("Theory ready · {count} samples · burn {duration} s · A {start} s · B {end} s", {
                count: data.points.length, duration: precise(stats.duration),
                start: precise(stats.start), end: precise(stats.end),
              }));
    bindText("theory-status", status);
    $("theory-status").classList.toggle("theory-error", Boolean(statusError));
  }
  function publish(renderOptions) {
    if (disposed) return;
    updateSnapshot();
    render(renderOptions);
    onChange(currentSnapshot);
  }
  function clearInvalid() {
    for (const id of CONTROL_IDS) $(id).removeAttribute("aria-invalid");
  }
  function invalidate(key, ids, source = true) {
    ++revision;
    if (source) {
      sourceValid = false;
      sourceError = message(key);
    } else timingValid = false;
    valid = sourceValid && timingValid;
    loading = false;
    statusError = message(key);
    for (const id of ids) $(id).setAttribute("aria-invalid", "true");
    publish();
  }
  function timingIsValid() {
    const offsetInput = $("theory-offset"), scaleInput = $("theory-scale");
    const nextOffset = offsetInput.valueAsNumber, nextScale = scaleInput.valueAsNumber / 100;
    if (offsetInput.validity.badInput || !Number.isFinite(nextOffset)) {
      invalidate("Enter a finite theoretical offset in seconds.", ["theory-offset"], false);
      return false;
    }
    if (scaleInput.validity.badInput || !Number.isFinite(nextScale) || nextScale <= 0) {
      invalidate("The theoretical duration must be a positive percentage.", ["theory-scale"], false);
      return false;
    }
    offset = nextOffset;
    scale = nextScale;
    timingValid = true;
    valid = sourceValid;
    statusError = sourceError;
    return true;
  }
  function eventsAreValid(candidate = options) {
    if (!data) return true;
    const invalidInputs = EVENT_FIELDS.filter(([id]) => $(id).validity.badInput).map(([id]) => id);
    if (invalidInputs.length) {
      invalidate("Enter a theoretical event time in seconds, or leave it empty.", invalidInputs);
      return false;
    }
    const event = (key) => candidate[key] === undefined ? stats?.[key] : candidate[key];
    const start = event("start"), end = event("end");
    if ([start, end].some((value) => value !== null && (!Number.isFinite(value) || value < data.start || value > data.end)) ||
      (Number.isFinite(start) && Number.isFinite(end) && end <= start)) {
      invalidate("Choose theoretical ignition before burnout, inside the CSV time range.", ["theory-start", "theory-end"]);
      return false;
    }
    return true;
  }
  async function analyze({ candidateFile = file, candidateSettings = settings,
    candidateOptions = options, replacement = false, reparse = false, rememberUnits = false } = {}) {
    if (!candidateFile) {
      valid = sourceValid && timingValid;
      statusError = sourceError;
      publish();
      return;
    }
    if (candidateFile.size > MAX_FILE_BYTES) {
      ++revision;
      stopWorker();
      loading = false;
      statusError = message("The theoretical CSV must be no larger than 20 MB.");
      publish({ fields: true });
      return;
    }
    reparse ||= JSON.stringify(candidateSettings) !== JSON.stringify(sourceSettings);
    const previousSourceValid = sourceValid;
    const previousSourceError = sourceError;
    const jobRevision = ++revision;
    if (replacement || reparse) stopWorker();
    const key = replacement || reparse ? `theory-${++sourceSequence}` : sourceKey;
    loading = true;
    statusError = null;
    publish();
    try {
      const result = await request({ key, file: candidateFile, settings: candidateSettings,
        options: candidateOptions, includeData: replacement || reparse });
      if (disposed || jobRevision !== revision) return;
      file = candidateFile;
      if (replacement) mode = importMode;
      settings = { ...candidateSettings };
      if (rememberUnits) importSettings = Object.fromEntries(UNIT_FIELDS.map(([, key]) => [key, settings[key]]));
      sourceSettings = { ...settings };
      options = { ...candidateOptions };
      sourceKey = key;
      if (result.data) {
        data = result.data;
        reduced = result.reduced;
      }
      stats = result.stats;
      loading = false;
      sourceValid = true;
      sourceError = null;
      valid = timingValid;
      statusError = null;
      clearInvalid();
      if (!timingIsValid()) return;
      publish({ fields: true });
    } catch (error) {
      if (disposed || jobRevision !== revision || error.name === "AbortError") return;
      loading = false;
      sourceValid = replacement || reparse ? previousSourceValid : false;
      sourceError = replacement || reparse ? previousSourceError : userMessage(error);
      valid = sourceValid && timingValid;
      statusError = userMessage(error);
      if (reparse) clearInvalid();
      else if (!replacement)
        for (const [id] of EVENT_FIELDS) $(id).setAttribute("aria-invalid", "true");
      publish({ fields: replacement || reparse });
      notice(statusError, "error");
    }
  }
  async function configureSource(candidateFile, { force = false, replacement = false } = {}) {
    const jobRevision = ++revision;
    loading = true;
    statusError = null;
    publish();
    try {
      if (candidateFile.size > MAX_FILE_BYTES)
        throw Object.assign(new Error(), { userMessage: message("The theoretical CSV must be no larger than 20 MB.") });
      const candidateSettings = await configureCSV(candidateFile, replacement ? { ...importSettings } : settings, { force });
      if (disposed || revision !== jobRevision) return;
      loading = false;
      if (!candidateSettings) { publish({ fields: true }); return; }
      const candidateOptions = replacement || eventIdentity(settings) !== eventIdentity(candidateSettings) ? {} : options;
      await analyze({ candidateFile, candidateSettings, candidateOptions, replacement, reparse: true });
    } catch (error) {
      if (disposed || revision !== jobRevision || error.name === "AbortError") return;
      loading = false;
      statusError = userMessage(error);
      publish({ fields: true });
      notice(statusError, "error");
    }
  }
  $("theory-add").onclick = () => $("theory-input").click();
  $("theory-columns").onclick = () => {
    if (loading) return;
    if (file) configureSource(file, { force: true });
    else { forceNextImport = true; $("theory-input").click(); }
  };
  $("theory-input").onchange = (event) => {
    const candidateFile = event.target.files[0];
    event.target.value = "";
    if (candidateFile) configureSource(candidateFile, { replacement: true, force: forceNextImport });
    forceNextImport = false;
  };
  $("theory-remove").onclick = () => {
    ++revision;
    stopWorker();
    file = data = stats = null;
    reduced = [];
    options = {};
    settings = { ...importSettings };
    sourceSettings = { ...settings };
    mode = importMode;
    sourceKey = "";
    loading = false;
    sourceValid = true;
    sourceError = null;
    valid = timingValid;
    statusError = null;
    clearInvalid();
    if (!timingIsValid()) {
      render({ fields: true });
      return;
    }
    publish({ fields: true });
  };
  $("theory-enabled").onchange = (event) => {
    enabled = event.target.checked;
    publish();
  };
  for (const [id, key] of UNIT_FIELDS) $(id).onchange = () => {
    const nextUnits = Object.fromEntries(UNIT_FIELDS.map(([input, name]) => [name, $(input).value]));
    const nextSettings = { ...settings, ...nextUnits };
    if (!file) {
      importSettings = { ...nextUnits };
      settings = nextSettings;
      publish();
    } else analyze({ candidateSettings: nextSettings,
      candidateOptions: key === "timeUnit" ? {} : options, reparse: true, rememberUnits: true });
  };
  for (const [id, key] of EVENT_FIELDS) $(id).onchange = () => {
    const input = $(id);
    clearInvalid();
    if (input.validity.badInput || (input.value !== "" && !Number.isFinite(input.valueAsNumber))) {
      invalidate("Enter a theoretical event time in seconds, or leave it empty.", [id]);
      return;
    }
    options = { ...options, [key]: input.value === "" ? null : input.valueAsNumber };
    if (!eventsAreValid()) return;
    analyze();
  };
  $("theory-detect").onclick = () => {
    options = {};
    analyze();
  };
  for (const id of ["theory-offset", "theory-scale", "theory-alignment"]) $(id).onchange = () => {
    for (const timingId of ["theory-offset", "theory-scale", "theory-alignment"])
      $(timingId).removeAttribute("aria-invalid");
    mode = $("theory-alignment").value;
    if (id === "theory-alignment") importMode = mode;
    if (!timingIsValid()) return;
    publish();
  };
  updateSnapshot();
  render({ fields: true });
  return {
    snapshot: () => currentSnapshot,
    applyPreferences(next) {
      if (disposed) return;
      importSettings = Object.fromEntries(UNIT_FIELDS.map(([, key]) => [key, next[key]]));
      importMode = next.mode;
      if (!file) {
        settings = { ...importSettings };
        sourceSettings = { ...settings };
        mode = importMode;
      }
      enabled = next.enabled;
      $("theory-enabled").checked = enabled;
      $("theory-alignment").value = mode;
      // Loaded source units, event edits and clock calibration belong to the current test.
      publish({ fields: true });
    },
    forMeasurement(measurement) {
      if (!enabled || !valid || loading || !file || !data || !stats) return null;
      const measured = {
        start: measurement?.startSet === false ? null : measurement?.start,
        end: measurement?.endSet === false ? null : measurement?.end,
      };
      const aligned = alignTheory(measured, stats, mode);
      if (!aligned) return null;
      const anchor = Number.isFinite(measured.start) ? measured.start : 0;
      try {
        const mapping = validateTheoryMapping({
          offset: anchor + (aligned.offset - anchor) * scale + offset,
          scale: aligned.scale * scale,
        });
        return { data, reduced, stats, name: file.name,
          offset: mapping.offset, timeScale: mapping.scale, mapping };
      } catch { return null; }
    },
    dispose() {
      disposed = true;
      ++revision;
      stopWorker();
      for (const id of [...CONTROL_IDS, "theory-add", "theory-input", "theory-remove", "theory-enabled"])
        $(id).onchange = $(id).onclick = null;
    },
  };
}
