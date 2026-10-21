import { $ } from "./dom.js";
import { defaultMetadata, defaultStyle } from "./overlay.js";
import { setLocale, LANGUAGE_STORAGE_KEY } from "./i18n.js";

export const PREFERENCES_STORAGE_KEY = "flamesync.preferences";
const STYLE_FIELDS = {
  "test-title": "title", "thrust-unit": "thrustUnit", "pressure-unit": "pressureUnit",
  "presentation-layout": "layout", "frame-aspect": "frameAspect", "chart-range": "chartRange",
  "overlay-height": "height", "overlay-opacity": "opacity", "show-pressure": "showPressure",
  "show-impulse": "showImpulse", "show-details": "showDetails", "summary-mode": "summaryMode",
  "video-scale": "videoScale", "video-position-x": "videoX", "video-position-y": "videoY",
};
const CSV_FIELDS = { "csv-time-unit": "timeUnit", "source-thrust-unit": "thrustUnit", "source-pressure-unit": "pressureUnit" };
const THEORY_FIELDS = { "theory-time-unit": "timeUnit", "theory-thrust-unit": "thrustUnit", "theory-pressure-unit": "pressureUnit" };
const EXTRA_FIELDS = [
  "export-format", "export-resolution", "export-quality", "export-fps", "keep-audio",
  ...Object.keys(CSV_FIELDS), ...Object.keys(THEORY_FIELDS), "theory-enabled", "theory-alignment",
  "profiles-mode", "profiles-source-time", "profiles-source-thrust", "profiles-source-pressure",
  "profiles-alignment", "profiles-metric", "profiles-trace", "profiles-thrust-unit", "profiles-pressure-unit",
  "profiles-threshold", "profiles-noise-window", "series-name", "series-band", "series-show-profiles",
  "measure-threshold", "show-measurement", "playback-rate",
];

// Storage accepts only these reusable fields. Files, parsed data, file names,
// A/B markers, trim bounds, source clocks, and synchronization never enter it.
export function createPreferencesController(editor) {
  const { state, video } = editor;
  const fields = new Map();
  const listeners = new AbortController();
  let values = {}, loaded = {}, timer = 0, dirty = false, suspended = false;
  let profiles, theory, storageWarned = false;
  function storageWarning() {
    if (storageWarned) return;
    storageWarned = true;
    editor.notice("Browser settings storage is unavailable. Changes will last only while this tab is open.", "warning");
  }
  function addField(id, dynamic = false) {
    const node = $(id);
    const boolean = node.type === "checkbox";
    const numeric = ["number", "range"].includes(node.type);
    const field = {
      node, boolean, numeric,
      initial: dynamic ? node.value : boolean ? node.defaultChecked
        : node.tagName === "SELECT" ? ([...node.options].find((option) => option.defaultSelected) ?? node.options[0]).value
          : node.defaultValue,
      options: node.tagName === "SELECT" ? [...node.options].map((option) => option.value) : null,
      min: node.min === "" || node.min === undefined ? -Infinity : Number(node.min),
      max: node.max === "" || node.max === undefined ? Infinity : Number(node.max),
      length: node.maxLength >= 0 ? node.maxLength : 240,
    };
    if (id === "overlay-opacity") { field.min = 0; field.max = 100; }
    fields.set(id, field);
    values[id] = valid(field, loaded[id], id) ? loaded[id] : field.initial;
  }
  function valid(field, value, id) {
    if (field.boolean) return typeof value === "boolean";
    if (typeof value !== "string") return false;
    if (field.options) return field.options.includes(value);
    if (field.numeric) return /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value)) &&
      Number(value) >= field.min && Number(value) <= field.max;
    if (value.length > field.length) return false;
    if (id === "meta-testDate" && value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(`${value}T00:00:00Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }
    return true;
  }
  function addVirtual(id, initial, options = null) {
    const field = { boolean: typeof initial === "boolean", options, initial };
    fields.set(id, field);
    values[id] = valid(field, loaded[id], id) ? loaded[id] : initial;
  }
  try {
    const text = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (text && text.length <= 64000) {
      const record = JSON.parse(text);
      if (record?.version === 1 && record.values && typeof record.values === "object" && !Array.isArray(record.values)) loaded = record.values;
    }
  } catch (error) {
    // Invalid JSON is ignored; blocked storage is reported once when the UI is ready.
    if (!(error instanceof SyntaxError)) storageWarned = true;
  }
  for (const id of [...Object.keys(defaultMetadata).map((key) => `meta-${key}`), ...Object.keys(STYLE_FIELDS), ...EXTRA_FIELDS]) addField(id);
  for (const key of ["theme", "trace"]) addVirtual(key, defaultStyle[key], [...document.querySelectorAll(`[data-${key}]`)].map((node) => node.dataset[key]));
  addVirtual("snapping", state.snapping);
  addVirtual("loopSelection", state.loopSelection);
  addVirtual("preview-muted", video.muted);

  function mapped(fields) { return Object.fromEntries(Object.entries(fields).map(([id, key]) => [key, values[id]])); }
  function normalizeOpacity() {
    const stacked = values["presentation-layout"] === "stacked";
    values["overlay-opacity"] = String(Math.max(stacked ? 0 : 45,
      Math.min(stacked ? 95 : 100, Number(values["overlay-opacity"]))));
    $("overlay-opacity").min = stacked ? "0" : "45";
    $("overlay-opacity").max = stacked ? "95" : "100";
  }
  function hydrate(preserveSources = false) {
    normalizeOpacity();
    const preserved = new Set(preserveSources ? [
      ...(state.data ? Object.keys(CSV_FIELDS) : []),
      ...(state.theory?.file ? Object.keys(THEORY_FIELDS) : []),
    ] : []);
    for (const [id, field] of fields) {
      if (!field.node || preserved.has(id)) continue;
      if (field.boolean) field.node.checked = values[id];
      else field.node.value = values[id];
    }
    for (const [id, key] of Object.entries(STYLE_FIELDS)) {
      const field = fields.get(id);
      state.style[key] = field.boolean ? values[id] : field.numeric ? Number(field.node.value) : field.node.value;
    }
    for (const key of ["theme", "trace"]) {
      state.style[key] = values[key];
      document.querySelectorAll(`[data-${key}]`).forEach((button) => {
        const selected = button.dataset[key] === values[key];
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      });
    }
    for (const key of Object.keys(defaultMetadata)) state.metadata[key] = values[`meta-${key}`];
    if (!preserveSources || !state.data) state.csvSettings = mapped(CSV_FIELDS);
    state.showMeasurement = values["show-measurement"];
    state.snapping = values.snapping;
    state.loopSelection = values.loopSelection;
    video.muted = values["preview-muted"];
    video.defaultPlaybackRate = video.playbackRate = Number(values["playback-rate"]);
    $("height-value").textContent = `${state.style.height}%`;
    $("opacity-value").textContent = `${state.style.opacity}%`;
  }
  hydrate();

  function flush() {
    clearTimeout(timer); timer = 0;
    if (!dirty || suspended) return;
    dirty = false;
    try { localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, values })); }
    catch { storageWarning(); }
  }
  function schedule() {
    if (suspended) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 180);
  }
  function saveControl(event) {
    if (suspended) return;
    const id = event.target.id, field = fields.get(id);
    if (!field?.node) return;
    // CSV units commit only after their asynchronous parse succeeds.
    if (id in CSV_FIELDS || id in THEORY_FIELDS) return;
    const value = field.boolean ? field.node.checked : field.node.value;
    if (!valid(field, value, id) || field.node.validity?.badInput) return;
    values[id] = value;
    if (id === "presentation-layout") {
      values["overlay-opacity"] = String(state.style.opacity);
      normalizeOpacity();
    }
    schedule();
  }
  function busy() {
    return Boolean(state.exporting || state.loading || state.csvLoading || state.theory?.loading || profiles?.isBusy());
  }
  function update() { $("clear-settings").disabled = busy(); }
  function clear() {
    if (busy()) return;
    suspended = true;
    clearTimeout(timer); timer = 0; dirty = false;
    editor.framing.cancel();
    for (const [id, field] of fields) values[id] = field.initial;
    hydrate(true);
    editor.player.applyPreferences();
    theory.applyPreferences({ ...mapped(THEORY_FIELDS), enabled: values["theory-enabled"], mode: values["theory-alignment"] });
    profiles.applyPreferences();
    setLocale("uk", { persist: false });
    let cleared = true;
    for (const key of [PREFERENCES_STORAGE_KEY, LANGUAGE_STORAGE_KEY]) {
      try { localStorage.removeItem(key); }
      catch { cleared = false; }
    }
    suspended = false;
    editor.refresh();
    editor.notice(cleared ? "Saved settings cleared. Default preferences restored."
      : "Defaults restored for this tab. Browser storage could not be cleared.", cleared ? "success" : "warning");
  }
  return {
    connect(controllers) {
      ({ profiles, theory } = controllers);
      // This select is populated by the series view after the initial bootstrap.
      addField("series-metric", true);
      $("series-metric").value = values["series-metric"];
      profiles.applyPreferences();
      theory.applyPreferences({ ...mapped(THEORY_FIELDS), enabled: values["theory-enabled"], mode: values["theory-alignment"] });
      editor.player.applyPreferences();
      document.addEventListener("input", saveControl, { signal: listeners.signal });
      document.addEventListener("change", saveControl, { signal: listeners.signal });
      document.addEventListener("click", (event) => {
        if (suspended) return;
        const button = event.target.closest("button");
        const key = button?.hasAttribute("data-theme") ? "theme" : button?.hasAttribute("data-trace") ? "trace" : null;
        if (key) { values[key] = state.style[key]; schedule(); }
        const stateKey = { "timeline-snap": "snapping", "timeline-loop": "loopSelection" }[button?.id];
        if (stateKey) { values[stateKey] = state[stateKey]; schedule(); }
        if (button?.id === "mute-button") { values["preview-muted"] = video.muted; schedule(); }
      }, { signal: listeners.signal });
      $("clear-settings").addEventListener("click", clear, { signal: listeners.signal });
      document.addEventListener("flamesync:profiles-busy", update, { signal: listeners.signal });
      update();
      if (storageWarned) { storageWarned = false; storageWarning(); }
    },
    csvImportSettings: () => mapped(CSV_FIELDS),
    saveCSVSettings(settings) {
      if (suspended) return;
      for (const [id, key] of Object.entries(CSV_FIELDS)) {
        if (!valid(fields.get(id), settings[key], id)) return;
      }
      for (const [id, key] of Object.entries(CSV_FIELDS)) values[id] = settings[key];
      schedule();
    },
    saveTheorySettings(settings) {
      if (suspended) return;
      let changed = false;
      for (const [id, key] of Object.entries(THEORY_FIELDS))
        if (!valid(fields.get(id), settings[key], id)) return;
      for (const [id, key] of Object.entries(THEORY_FIELDS)) {
        changed ||= values[id] !== settings[key];
        values[id] = settings[key];
      }
      if (changed) schedule();
    },
    saveFraming() {
      if (suspended) return;
      for (const [id, key] of Object.entries(STYLE_FIELDS)) if (key.startsWith("video")) values[id] = String(state.style[key]);
      schedule();
    },
    update,
    dispose() { flush(); listeners.abort(); },
  };
}
