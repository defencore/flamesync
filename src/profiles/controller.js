import { $ } from "../dom.js";
import { t, renderMessage } from "../i18n.js";
import { errorMessage, message } from "../messages.js";
import { preciseSeconds } from "../data.js";
import { displayThrust, displayPressure } from "../units.js";
import { createProfileWorker } from "./worker-client.js";
import { createProfileChart } from "./chart.js";
import { renderResults, exportResults, number } from "./results.js";
import { profileExamples, seriesExamples } from "./examples.js";
import { createSeriesView } from "./series-view.js";
import { PROFILE_LIMIT, PROFILE_MAX_BYTES, WORKSPACE_MAX_BYTES } from "./limits.js";
import { DEFAULT_CSV_SETTINGS } from "../units.js";
import { profileMapping } from "./model.js";
import { renderTheoryComparison } from "./theory-view.js";

const COLORS = ["#2b61a5", "#bd6530", "#268477", "#885eae", "#b34c73", "#747c21", "#216e91", "#a45245", "#67718f", "#658638", "#a47b21", "#8e5586"];
const own = (object, key) => Object.hasOwn(object, key);
const fileError = (name, error) => () => message("{name}: {details}", { name, details: renderMessage(error) });
const renderNotice = (value) => Array.isArray(value) ? value.map(renderNotice).join(" ") : renderMessage(typeof value === "function" ? value() : value);
const field = (record, key) => record.card.querySelector(`[data-field="${key}"]`);
const textNode = (tag, text, className) => {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
};

export function createProfileWorkspace() {
  const worker = createProfileWorker(), records = [];
  let reference = "", selected = "", sequence = 0, revision = 0, busy = 0,
    threshold = $("profiles-threshold").valueAsNumber,
    noiseWindow = $("profiles-noise-window").valueAsNumber / 1000,
    view = null, crosshair = null, pick = null,
    hoverPending = false, hoverRevision = 0, noticeValue = null, noticeKind = "success", disposed = false,
    pendingCount = 0, pendingBytes = 0, seriesResult = null,
    theoryState = null, workerTheoryData = null, workerTheoryStats = null, theoryCurves = null, importSequence = 0,
    lastBusy = false;
  const panel = $("profile-analysis");
  const comparisonHelp = $("profiles-difference-help").getAttribute("data-i18n-data-help");
  const metric = () => $("profiles-metric").value;
  const alignment = () => $("profiles-alignment").value;
  const units = () => ({ thrust: $("profiles-thrust-unit").value, pressure: $("profiles-pressure-unit").value });
  const visible = () => records.filter((record) => record.visible && record.mapping);
  const currentReference = () => records.find((record) => record.id === reference);
  const isSeries = () => $("profiles-mode").value === "series";
  const seriesView = createSeriesView({ onDisplayChange: () => update() });
  const options = { onViewChange(next) { view = next; draw(); }, onHover(x) { crosshair = x; draw(); sampleHover(); } };
  const chart = createProfileChart($("profiles-chart"), { ...options,
    onPick(x) { if (pick) commitMarker(pick.id, pick.event, x); },
    onMarkerChange(id, x) { const [recordId, event] = id.split(":"); commitMarker(recordId, event, x); },
  });
  const pressureChart = createProfileChart($("profiles-pressure-chart"), { ...options,
    onPick(x) { if (pick) commitMarker(pick.id, pick.event, x); },
    onMarkerChange(id, x) { const [recordId, event] = id.split(":"); commitMarker(recordId, event, x); },
  });
  const difference = createProfileChart($("profiles-difference"), options);

  function notice(value, kind = "success") {
    noticeValue = value; noticeKind = kind;
    $("profiles-notice").hidden = !value;
    $("profiles-notice").className = `profile-notice ${kind}`;
    $("profiles-notice").textContent = value ? renderNotice(value) : "";
  }
  function updateBusyState() {
    const next = Boolean(busy || pendingCount);
    panel.setAttribute("aria-busy", String(next));
    if (next !== lastBusy) {
      lastBusy = next;
      document.dispatchEvent(new CustomEvent("flamesync:profiles-busy", { detail: { busy: next } }));
    }
  }
  function setBusy(change) {
    busy += change;
    updateBusyState();
    $("profiles-processing").hidden = busy === 0;
    $("profiles-export").disabled = busy > 0 || !records.length || records.some((record) => record.error);
    $("profiles-demo").disabled = busy > 0;
    $("profiles-theory-export").disabled = busy > 0 || !records.length || records.some((record) => record.error);
    seriesView.update(seriesResult, records, { active: isSeries(), units: units(), alignment: alignment(), threshold, noiseWindow, busy: busy > 0 });
  }
  async function operation(run) {
    setBusy(1);
    try { await run(); }
    catch (error) { if (error.name !== "AbortError") notice(error.userMessage ?? errorMessage(error), "error"); }
    finally { setBusy(-1); }
  }
  function translateCard(record) {
    record.card.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
    for (const attribute of ["title", "aria-label", "placeholder"])
      record.card.querySelectorAll(`[data-i18n-${attribute}]`).forEach((node) => node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`))));
    field(record, "visible").setAttribute("aria-label", t("Show {name}", { name: record.name }));
  }
  function updateCard(record) {
    translateCard(record);
    record.card.classList.toggle("is-reference", record.id === reference);
    record.card.classList.toggle("is-selected", record.id === selected);
    record.card.classList.toggle("is-hidden", !record.visible);
    record.card.querySelector('[data-action="reference"]').setAttribute("aria-pressed", String(record.id === reference));
    record.card.querySelector('[data-action="reference"]').textContent = t(record.id === reference ? "Reference" : "Set reference");
    record.card.querySelector(".profile-source-meta").textContent = t("{count} samples · {rate} Hz · {start}–{end} s", {
      count: record.count, rate: number(record.rate, 1), start: preciseSeconds(record.start), end: preciseSeconds(record.end),
    });
    field(record, "visible").checked = record.visible;
    field(record, "included").checked = record.included;
    field(record, "included").closest("label").hidden = !isSeries();
    record.card.querySelector('[data-action="reference"]').hidden = isSeries();
    for (const key of ["start", "end"])
      if (!record.invalid?.has(key) && document.activeElement !== field(record, key)) {
        const value = own(record.options, key) ? record.options[key] : record.stats?.[key];
        field(record, key).value = Number.isFinite(value) ? preciseSeconds(value) : "";
      }
    const error = record.card.querySelector(".profile-card-error");
    error.hidden = !record.error; error.textContent = record.error ? renderMessage(record.error) : "";
    const warnings = record.card.querySelector(".profile-card-warnings");
    // The method note is already available from the global information tooltip.
    const messages = record.stats?.warnings.filter((value) => !value.key.startsWith("Noise is residual variation")) ?? [];
    warnings.replaceChildren(...messages.map((value) => textNode("li", renderMessage(value))));
    warnings.hidden = !messages.length;
    record.card.querySelector(".profile-noise-range").textContent = Number.isFinite(record.stats?.noiseStart) && Number.isFinite(record.stats?.noiseEnd)
      ? t("Noise interval: {start}–{end} s", { start: preciseSeconds(record.stats.noiseStart), end: preciseSeconds(record.stats.noiseEnd) }) : "";
  }
  function update() {
    if (!records.some((record) => record.id === reference)) reference = records.find((record) => record.visible)?.id ?? records[0]?.id ?? "";
    if (!records.some((record) => record.id === selected)) selected = reference;
    const select = $("profiles-reference");
    select.replaceChildren(...records.map((record) => new Option(record.name, record.id)));
    select.value = reference; select.disabled = !records.length;
    $("profiles-count").textContent = `${records.length} / ${PROFILE_LIMIT}`;
    $("profiles-clear").disabled = !records.length;
    $("profiles-results-empty").hidden = !!records.length;
    $("profiles-export").disabled = busy > 0 || !records.length || records.some((record) => record.error);
    for (const record of records) updateCard(record);
    $("profiles-pick-status").hidden = !pick;
    if (pick) $("profiles-pick-text").textContent = t(pick.event === "start" ? "Select ignition for {name} on the chart." : "Select burnout for {name} on the chart.", { name: records.find((record) => record.id === pick.id)?.name ?? "" });
    renderResults(records, currentReference(), units(), metric());
    renderTheoryComparison(records, theoryState, units(), alignment(), busy > 0);
    for (const id of ["series-panel", "series-name-label", "series-chart-controls", "series-folder"]) $(id).hidden = !isSeries();
    $("profiles-results").hidden = isSeries();
    $("profiles-reference").closest("label").hidden = isSeries();
    $("profiles-trace").closest("label").hidden = isSeries();
    setHeading("profiles-overlay-title", isSeries() ? "Series mean and spread" : "Profile overlay");
    setHeading("profiles-difference-title", isSeries() ? "Deviations from series mean" : "Difference from reference");
    const help = isSeries() ? "Each visible test is compared with the equal-weight series mean on the common aligned burn interval. The band is spread between tests, not an acceptance limit. Curves are display approximations; report metrics use original selected-interval values." : comparisonHelp;
    $("profiles-difference-help").setAttribute("data-i18n-data-help", help);
    $("profiles-difference-help").dataset.help = t(help);
    seriesView.update(seriesResult, records, { active: isSeries(), units: units(), alignment: alignment(), threshold, noiseWindow, busy: busy > 0 });
    panel.querySelectorAll("select").forEach((select) => { select.title = select.selectedOptions[0]?.textContent ?? ""; });
    const legendRecords = isSeries() && !seriesView.settings().showProfiles ? records.filter((record) => record.id === selected) : records;
    $("profiles-legend").replaceChildren(...legendRecords.map((record) => {
      const button = textNode("button", record.name, "profile-legend-item");
      button.style.setProperty("--profile-color", record.color);
      button.classList.toggle("is-hidden", !record.visible); button.classList.toggle("is-selected", record.id === selected);
      button.setAttribute("aria-pressed", String(record.id === selected)); button.title = record.name;
      button.onclick = () => { selected = record.id; update(); };
      return button;
    }));
    if (isSeries() && seriesResult?.curve) {
      const mean = textNode("span", t("Series mean and spread"), "profile-legend-item");
      mean.style.setProperty("--profile-color", "#244e78"); $("profiles-legend").prepend(mean);
    }
    if (theoryActive()) {
      const legend = textNode("span", `${t("Theory")} · ${theoryState.name}`, "profile-legend-item");
      legend.style.setProperty("--profile-color", "#ab8119"); $("profiles-legend").append(legend);
    }
    draw();
  }
  function setHeading(id, key) { $(id).dataset.i18n = key; $(id).textContent = t(key); }
  function domain() {
    if (alignment() === "normalized") return { start: 0, end: 100 };
    const common = isSeries() ? seriesResult?.curve : null;
    let start = common?.start ?? Infinity, end = common?.end ?? -Infinity;
    for (const record of common ? [] : visible()) {
      start = Math.min(start, record.mapping.offset + record.start * record.mapping.scale);
      end = Math.max(end, record.mapping.offset + record.end * record.mapping.scale);
    }
    if (theoryActive()) {
      const mapping = profileMapping(theoryState.stats, alignment());
      if (mapping) { start = Math.min(start, mapping.offset + theoryState.data.start * mapping.scale); end = Math.max(end, mapping.offset + theoryState.data.end * mapping.scale); }
    }
    return end > start ? { start, end } : { start: 0, end: 1 };
  }
  function theoryActive() { return !!(theoryState?.data && theoryState.enabled && theoryState.sourceValid && !theoryState.loading); }
  function signalPlots(settings, lines, markers) {
    const series = [...lines];
    if (theoryActive()) {
      const mapping = profileMapping(theoryState.stats, alignment());
      const trace = isSeries() ? "raw" : $("profiles-trace").value;
      if (mapping) series.push({ id: "theoretical-profile", name: t("Theory"), color: "#ab8119", lineWidth: 2.5, dash: [7, 4], points: (theoryCurves ?? theoryState.stats.curves)[trace], mapping });
    }
    chart.render({ ...settings, metric: "thrust", unit: units().thrust, yLabel: `${t("Thrust")} · ${units().thrust}`, markers, series });
    pressureChart.render({ ...settings, metric: "pressure", unit: units().pressure, yLabel: `${t("Pressure")} · ${units().pressure}`, markers, series });
  }
  function draw() {
    if (disposed || panel.hidden) return;
    const candidates = visible(), active = records.find((record) => record.id === selected), signal = metric();
    const markers = [];
    if (active?.visible && active.mapping) for (const event of ["start", "end"]) {
      if (Number.isFinite(active.stats?.[event])) markers.push({ id: `${active.id}:${event}`, label: event === "start" ? "A" : "B", x: active.mapping.offset + active.stats[event] * active.mapping.scale, color: active.color });
    }
    const xLabel = t(alignment() === "normalized" ? "Burn phase (%)" : alignment() === "ignition" ? "Time from ignition (s)" : alignment() === "burnout" ? "Time from burnout (s)" : "CSV time (s)");
    const settings = { metric: signal, unit: units()[signal], xLabel, yLabel: `${t(signal === "thrust" ? "Thrust" : "Pressure")} · ${units()[signal]}`, view: view ?? domain(), crosshair };
    if (isSeries()) {
      const display = seriesView.settings(), mean = seriesResult?.curve;
      const individuals = candidates.filter((record) => display.showProfiles || record.id === selected);
      const lines = individuals.map((record) => ({ id: record.id, name: record.name, color: record.color, points: record.stats.curves.raw, mapping: record.mapping }));
      if (mean) lines.push({ id: "series-mean", name: t("Series mean"), color: "#244e78", lineWidth: 2.8, points: mean.points, mapping: { offset: 0, scale: 1 }, band: display.band });
      signalPlots(settings, lines, markers);
      const deltas = (seriesResult?.curves ?? []).filter((curve) => display.showProfiles || curve.id === selected).filter((curve) => records.find((record) => record.id === curve.id)?.visible).map((curve) => {
        const record = records.find((item) => item.id === curve.id);
        return { id: record.id, name: record.name, color: record.color, points: curve.points, mapping: { offset: 0, scale: 1 } };
      });
      if (mean) deltas.unshift({ id: "series-spread", name: t("Series spread around mean"), color: "#244e78", points: seriesResult.zeroCurve, mapping: { offset: 0, scale: 1 }, band: display.band });
      difference.render({ ...settings, zeroLine: true, series: deltas });
      $("profiles-difference-status").hidden = !!mean;
      $("profiles-difference-status").textContent = t("No common eligible burn interval. Review events or align ignition or both events.");
      $("profiles-empty").hidden = !!mean || !!individuals.length;
      $("profiles-empty").lastElementChild.textContent = t("Add a series of CSV logs and review the burn events.");
      $("profiles-chart").classList.toggle("is-picking", !!pick);
      return;
    }
    signalPlots(settings, candidates.map((record) => ({ id: record.id, name: record.name, color: record.color, points: record.stats.curves[$("profiles-trace").value], mapping: record.mapping })), markers);
    const refVisible = currentReference()?.visible;
    const differences = refVisible ? candidates.filter((record) => record.id !== reference && record.difference).map((record) => ({ id: record.id, name: record.name, color: record.color, points: record.difference.points, mapping: { offset: 0, scale: 1 } })) : [];
    difference.render({ ...settings, zeroLine: true, series: differences });
    const differenceStatus = $("profiles-difference-status");
    differenceStatus.hidden = !!differences.length;
    differenceStatus.textContent = t(records.length < 2 ? "Add two or more CSV logs. No video is required." : !refVisible ? "The reference profile is hidden. Show it to compare differences." : "No common selected burn interval.");
    $("profiles-empty").hidden = !!candidates.length;
    $("profiles-empty").lastElementChild.textContent = t(records.length ? "No profiles can be aligned. Set the missing burn events or choose original CSV time." : "Add two or more CSV logs. No video is required.");
    $("profiles-chart").classList.toggle("is-picking", !!pick);
  }
  async function analyze() {
    const version = ++revision;
    if (workerTheoryData !== theoryState?.data || workerTheoryStats !== theoryState?.stats) {
      workerTheoryData = theoryState?.data; workerTheoryStats = theoryState?.stats;
      await worker.request({ type: "setTheory", theory: workerTheoryData && workerTheoryStats ? { data: workerTheoryData, stats: workerTheoryStats } : null });
    }
    const result = await worker.request({ type: "analyze", profiles: records.map((record) => ({ id: record.id, options: record.options, included: record.included, valid: !record.invalid.size })), threshold, noiseWindow, alignment: alignment(), reference, series: isSeries(), theory: theoryActive() });
    if (version !== revision || disposed) return;
    seriesResult = result.series;
    theoryCurves = result.theoryCurves;
    for (const item of result.records) {
      const record = records.find((record) => record.id === item.id);
      if (!record) continue;
      record.error = record.invalid.size ? message(record.invalid.has("mass") ? "Enter a positive propellant mass or leave it empty." : "Choose a valid value inside the CSV time range.") : item.error ?? null;
      record.stats = record.error ? null : item.stats ?? null;
      record.mapping = record.error ? null : item.mapping ?? null;
      record.difference = record.error ? null : item.difference ?? null;
      record.theoryDifference = record.error ? null : item.theoryDifference ?? null;
      for (const key of ["start", "end", "mass", "noiseStart", "noiseEnd"]) {
        const rangeError = item.error?.key.startsWith(key.startsWith("noise") ? "Choose a noise interval" : "Choose ignition before burnout") && key !== "mass";
        field(record, key).setAttribute("aria-invalid", String(!!rangeError || record.invalid.has(key)));
      }
    }
    update();
  }
  function createCard(record) {
    const card = $("profile-card-template").content.firstElementChild.cloneNode(true);
    record.card = card; record.invalid = new Set();
    card.dataset.profileId = record.id; card.style.setProperty("--profile-color", record.color);
    card.querySelector(".profile-swatch").style.background = record.color;
    card.querySelector(".profile-name").textContent = record.name;
    card.querySelector(".profile-name").title = record.name;
    for (const [key, value] of Object.entries(record.settings)) field(record, key).value = value;
    card.addEventListener("focusin", () => { if (selected !== record.id) { selected = record.id; draw(); } });
    card.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (!action) return;
      selected = record.id;
      if (action === "reference") { reference = record.id; operation(analyze); }
      if (action === "remove") {
        records.splice(records.indexOf(record), 1); card.remove(); cancelPick(); view = null; revision++;
        update(); operation(async () => { await worker.request({ type: "remove", id: record.id }); await analyze(); });
      }
      if (action === "detect") {
        delete record.options.start; delete record.options.end;
        record.invalid.delete("start"); record.invalid.delete("end");
        for (const key of ["start", "end"]) field(record, key).removeAttribute("aria-invalid");
        operation(analyze);
      }
      if (action.startsWith("pick-")) {
        if (!record.mapping) { $("profiles-alignment").value = "source"; view = null; }
        pick = { id: record.id, event: action.slice(5) };
        operation(async () => { await analyze(); update(); $("profiles-chart").focus({ preventScroll: true }); });
      }
    });
    card.addEventListener("change", (event) => {
      const key = event.target.dataset.field;
      if (key === "visible") { record.visible = event.target.checked; update(); return; }
      if (key === "included") { record.included = event.target.checked; operation(analyze); return; }
      if (["timeUnit", "thrustUnit", "pressureUnit"].includes(key)) {
        const previous = record.settings, settings = { ...previous, [key]: event.target.value };
        record.settings = settings;
        operation(async () => {
          const result = await worker.request({ type: "import", entries: [{ id: record.id, settings }] });
          if (result.errors.length) { if (record.settings === settings) { record.settings = previous; event.target.value = previous[key]; } notice(fileError(record.name, result.errors[0].error), "error"); return; }
          if (!records.includes(record)) return;
          Object.assign(record, result.records[0]);
          if (key === "timeUnit") {
            delete record.options.start; delete record.options.end; delete record.options.noiseStart; delete record.options.noiseEnd;
            field(record, "noiseStart").value = ""; field(record, "noiseEnd").value = "";
            for (const name of ["start", "end", "noiseStart", "noiseEnd"]) record.invalid.delete(name);
          }
          view = null; await analyze();
        }); return;
      }
      if (["start", "end", "mass", "noiseStart", "noiseEnd"].includes(key)) setField(record, key, event.target);
    });
    $("profiles-list").append(card);
  }
  function setField(record, key, input) {
    const empty = input.value === "" && !input.validity.badInput, value = empty ? null : input.valueAsNumber;
    const invalid = input.validity.badInput || (!empty && (!Number.isFinite(value) || (key === "mass" ? value <= 0 : value < record.start || value > record.end)));
    input.setAttribute("aria-invalid", String(invalid));
    if (invalid) {
      record.invalid.add(key); record.error = message(key === "mass" ? "Enter a positive propellant mass or leave it empty." : "Choose a valid value inside the CSV time range.");
      record.stats = null; record.mapping = null; record.difference = null;
      update(); if (isSeries()) operation(analyze); return;
    }
    record.invalid.delete(key);
    if (key === "mass") record.options.massKg = empty ? null : value / 1000;
    else if (key.startsWith("noise") && empty) delete record.options[key];
    else record.options[key] = value;
    view = null; operation(analyze);
  }
  function commitMarker(id, event, x) {
    const record = records.find((record) => record.id === id);
    if (!record?.mapping) return;
    const time = (x - record.mapping.offset) / record.mapping.scale;
    if (time < record.start - 1e-9 || time > record.end + 1e-9) return;
    field(record, event).value = preciseSeconds(Math.max(record.start, Math.min(record.end, time)));
    cancelPick(); setField(record, event, field(record, event));
  }
  function cancelPick() { pick = null; $("profiles-pick-status").hidden = true; draw(); }
  async function importFiles(files, settingsOverride = null) {
    const importVersion = ++importSequence;
    const accepted = [], failures = [];
    let total = pendingBytes + records.reduce((sum, record) => sum + record.size, 0);
    for (const file of files) {
      if (records.length + pendingCount + accepted.length >= PROFILE_LIMIT || file.size > PROFILE_MAX_BYTES || total + file.size > WORKSPACE_MAX_BYTES) {
        failures.push(message("Add up to 50 CSV logs, each smaller than 20 MB (100 MB total).")); continue;
      }
      const settings = settingsOverride ? { ...settingsOverride } : { timeUnit: $("profiles-source-time").value, thrustUnit: $("profiles-source-thrust").value, pressureUnit: $("profiles-source-pressure").value };
      accepted.push({ id: `p${++sequence}`, file, settings }); total += file.size;
    }
    pendingCount += accepted.length;
    const bytes = accepted.reduce((sum, entry) => sum + entry.file.size, 0);
    pendingBytes += bytes;
    await operation(async () => {
      const result = await worker.request({ type: "import", entries: accepted });
      for (const item of result.records) {
        const record = { ...item, settings: accepted.find((entry) => entry.id === item.id).settings,
          color: records.length < COLORS.length ? COLORS[records.length] : `hsl(${(sequence * 137.508 + records.length * 51) % 360} 48% 40%)`, visible: true, included: true, options: {} };
        records.push(record); createCard(record);
      }
      for (const error of result.errors) failures.push(fileError(error.name, error.error));
      view = null; update(); await analyze();
      if (importVersion === importSequence) notice(failures.length ? failures : message("{count} profiles loaded. Review the detected burn events.", { count: result.records.length }), failures.length ? "error" : "success");
    });
    pendingCount -= accepted.length; pendingBytes -= bytes;
    updateBusyState();
  }
  async function sampleHover() {
    const version = ++hoverRevision;
    if (crosshair === null) { $("profiles-hover").textContent = ""; return; }
    if (hoverPending) return;
    hoverPending = true;
    const x = crosshair;
    try {
      const { samples } = await worker.request({ type: "sample", x, profiles: visible().map(({ id, mapping }) => ({ id, mapping })) });
      if (version !== hoverRevision) return;
      $("profiles-hover").replaceChildren(...samples.filter((sample) => sample.point).map((sample) => {
        const record = records.find((record) => record.id === sample.id);
        return textNode("span", `${record.name}: ${number(displayThrust(sample.point.thrust, units().thrust))} ${units().thrust} · ${number(displayPressure(sample.point.pressure, units().pressure))} ${units().pressure} · ${t("Source time")} ${preciseSeconds(sample.time)} s`);
      }));
      if (!$("profiles-hover").childElementCount) $("profiles-hover").textContent = t("No samples at this time.");
    } catch { /* A cleared workspace cancels pending readouts. */ }
    finally { hoverPending = false; if (version !== hoverRevision && crosshair !== null && !disposed) sampleHover(); }
  }
  $("profiles-add").onclick = () => $("profiles-input").click();
  $("profiles-input").onchange = (event) => { importFiles([...event.target.files]); event.target.value = ""; };
  $("profiles-demo").onclick = () => importFiles(isSeries() ? seriesExamples() : profileExamples(), DEFAULT_CSV_SETTINGS);
  $("profiles-mode").onchange = () => { view = null; cancelPick(); update(); operation(analyze); };
  $("series-folder").onclick = () => $("series-folder-input").click();
  $("series-folder-input").onchange = (event) => {
    const files = [...event.target.files].filter((file) => /\.(csv|tsv|txt)$/i.test(file.name));
    if (files.length) importFiles(files);
    else notice(message("The selected folder contains no CSV, TSV, or TXT logs."), "error");
    event.target.value = "";
  };
  $("profiles-clear").onclick = () => {
    revision++; importSequence++; worker.dispose(); records.splice(0); reference = ""; selected = ""; view = null; seriesResult = null;
    workerTheoryData = null; workerTheoryStats = null;
    $("profiles-list").replaceChildren(); cancelPick(); notice(null); update();
  };
  const drop = $("profiles-drop");
  drop.onclick = () => $("profiles-input").click();
  drop.onkeydown = (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); drop.click(); } };
  drop.ondragover = (event) => { event.preventDefault(); drop.classList.add("dragover"); };
  drop.ondragleave = () => drop.classList.remove("dragover");
  drop.ondrop = (event) => { event.preventDefault(); drop.classList.remove("dragover"); importFiles([...event.dataTransfer.files]); };
  $("profiles-reference").onchange = (event) => { reference = event.target.value; operation(analyze); };
  $("profiles-alignment").onchange = () => { view = null; cancelPick(); operation(analyze); };
  for (const id of ["profiles-metric", "profiles-trace", "profiles-thrust-unit", "profiles-pressure-unit"]) $(id).onchange = () => update();
  function readAnalysisPreferences() {
    const nextThreshold = $("profiles-threshold").valueAsNumber, nextWindow = $("profiles-noise-window").valueAsNumber;
    if (!(nextThreshold >= .1 && nextThreshold <= 99.9 && nextWindow >= 1 && nextWindow <= 10000)) {
      notice(message("Choose a threshold between 0.1% and 99.9%, and a moving window from 1 to 10000 ms."), "error"); return false;
    }
    threshold = nextThreshold; noiseWindow = nextWindow / 1000;
    return true;
  }
  for (const id of ["profiles-threshold", "profiles-noise-window"]) $(id).onchange = () => {
    if (!readAnalysisPreferences()) return;
    view = null; operation(analyze);
  };
  $("profiles-fit").onclick = () => { view = null; draw(); };
  $("profiles-pick-cancel").onclick = cancelPick;
  $("profiles-export").onclick = () => exportResults(records, currentReference(), alignment(), { threshold, noiseWindow });
  const onKey = (event) => { if (!panel.hidden && event.key === "Escape") cancelPick(); };
  const onLanguage = () => { if (noticeValue) notice(noticeValue, noticeKind); update(); };
  document.addEventListener("keydown", onKey);
  document.addEventListener("flamesync:language", onLanguage);
  update();
  return {
    activate: draw,
    isBusy: () => Boolean(busy || pendingCount),
    applyPreferences() {
      if (disposed || !readAnalysisPreferences()) return Promise.resolve();
      view = crosshair = null;
      hoverRevision++;
      $("profiles-hover").replaceChildren();
      cancelPick();
      // Recompute shared methods once without changing per-file inputs or membership.
      return operation(analyze);
    },
    setTheory(next) { const previous = theoryState; theoryState = next; if (previous?.data !== next.data || previous?.stats !== next.stats || previous?.enabled !== next.enabled || previous?.sourceValid !== next.sourceValid || previous?.loading !== next.loading) operation(analyze); else update(); },
    dispose() { disposed = true; worker.dispose(); chart.dispose(); pressureChart.dispose(); difference.dispose(); document.removeEventListener("keydown", onKey); document.removeEventListener("flamesync:language", onLanguage); },
  };
}
