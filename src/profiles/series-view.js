import { $ } from "../dom.js";
import { t, renderMessage } from "../i18n.js";
import { displayThrust, displayPressure } from "../units.js";
import { downloadBlob } from "../files.js";
import { number, SOURCE_REPORT_COLUMNS, sourceReport } from "./results.js";

export const SERIES_METRICS = [
  { key: "duration", label: "Burn duration", unit: "s" },
  { key: "impulse", label: "Total impulse", signal: "thrust", impulse: true },
  { key: "meanThrust", label: "Mean thrust", signal: "thrust" },
  { key: "peakThrust", label: "Peak thrust", signal: "thrust" },
  { key: "meanPressure", label: "Mean pressure", signal: "pressure" },
  { key: "peakPressure", label: "Peak pressure", signal: "pressure" },
  { key: "noiseThrustRms", label: "Thrust residual RMS", signal: "thrust" },
  { key: "noisePressureRms", label: "Pressure residual RMS", signal: "pressure" },
  { key: "noiseThrustPercent", label: "Relative thrust residual", unit: "%" },
  { key: "specificImpulse", label: "Specific impulse", unit: "s" },
];
const unitFor = (metric, units) => metric.unit ?? `${units[metric.signal]}${metric.impulse ? "·s" : ""}`;
const convert = (value, metric, units) => !Number.isFinite(value) ? null : metric.signal === "thrust"
  ? displayThrust(value, units.thrust) : metric.signal === "pressure" ? displayPressure(value, units.pressure) : value;
function cell(tag, text, value, key) {
  const node = document.createElement(tag); node.textContent = text;
  if (key) { node.dataset.value = Number.isFinite(value) ? String(value) : ""; node.dataset.seriesValue = key; node.dataset.stat = key; }
  return node;
}
function header(table, labels) {
  const row = document.createElement("tr");
  for (const label of labels) { const node = cell("th", label); node.scope = "col"; row.append(node); }
  table.tHead.replaceChildren(row);
}
const csvText = (value) => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
const csvNumber = (value) => Number.isFinite(value) ? String(value) : "";

export function createSeriesView({ onDisplayChange }) {
  let result = null, records = [], settings = null;
  const selection = $("series-metric");
  for (const metric of SERIES_METRICS) selection.add(new Option(t(metric.label), metric.key));
  selection.value = "impulse";
  selection.onchange = () => render();
  for (const id of ["series-band", "series-show-profiles"]) $(id).onchange = onDisplayChange;
  $("series-name").oninput = () => { $("series-name").removeAttribute("aria-invalid"); };

  function render() {
    if (!settings?.active) return;
    for (const option of selection.options) option.textContent = t(SERIES_METRICS.find((metric) => metric.key === option.value).label);
    const eligible = result?.eligibleCount ?? 0, included = records.filter((record) => record.included).length;
    $("series-count").textContent = t("{eligible} of {included} included tests are eligible", { eligible, included });
    $("series-export").disabled = !eligible || settings.busy;
    $("series-small-sample").hidden = eligible >= 5;
    const summary = $("series-summary");
    header(summary, [t("Metric"), t("Tests (n)"), t("Series mean"), t("Sample standard deviation"), `${t("Coefficient of variation")} · %`, t("Minimum"), t("Maximum")]);
    const summaryRows = document.createDocumentFragment();
    for (const metric of SERIES_METRICS) {
      const stats = result?.metrics[metric.key], row = document.createElement("tr"), unit = unitFor(metric, settings.units);
      row.dataset.seriesStat = metric.key;
      const label = cell("th", `${t(metric.label)} · ${unit}`); label.scope = "row"; row.append(label);
      for (const key of ["n", "mean", "sd", "cv", "min", "max"]) {
        const value = stats?.[key] ?? null;
        const formatted = key === "n" ? number(value ?? 0, 0) : key === "cv" ? number(value, 2) : number(convert(value, metric, settings.units));
        row.append(cell("td", formatted, value ?? (key === "n" ? 0 : null), key));
      }
      summaryRows.append(row);
    }
    summary.tBodies[0].replaceChildren(summaryRows);
    const selectedMetric = SERIES_METRICS.find((metric) => metric.key === selection.value), unit = unitFor(selectedMetric, settings.units);
    const members = $("series-members");
    header(members, [t("Profile"), `${t("Value")} · ${unit}`, `${t("Difference from mean")} · ${unit}`, t("Deviation (%)"), t("Standard score (z)"), t("Series status")]);
    const memberRows = document.createDocumentFragment();
    for (const record of records) {
      const deviation = result?.deviations.find((item) => item.id === record.id)?.metrics[selectedMetric.key];
      const exclusion = result?.excluded.find((item) => item.id === record.id);
      const isEligible = result?.eligibleIds.includes(record.id) ?? false;
      const row = document.createElement("tr"); row.dataset.profileId = record.id; row.dataset.outlier = String(!!deviation?.outlier);
      row.dataset.eligible = String(isEligible);
      const name = cell("th", record.name); name.scope = "row"; name.title = record.name;
      name.style.borderLeft = `3px solid ${record.color}`; row.append(name);
      for (const key of ["value", "delta", "percent", "z"]) {
        const value = deviation?.[key] ?? null;
        row.append(cell("td", number(["value", "delta"].includes(key) ? convert(value, selectedMetric, settings.units) : value, key === "percent" ? 2 : 3), value, key));
      }
      row.append(cell("td", !record.included ? t("Excluded by user") : exclusion ? renderMessage(exclusion.reason)
        : !deviation || !Number.isFinite(deviation.value) ? t("This metric is unavailable")
          : deviation.outlier ? t("Potential outlier · review") : t("Included")));
      memberRows.append(row);
    }
    members.tBodies[0].replaceChildren(memberRows);
  }
  function exportReport() {
    if (!result?.eligibleCount || settings.busy) return;
    const columns = ["series", "row_type", "metric", "metric_unit", "profile", "n", "value", "mean", "sd", "cv_percent", "min", "max", "median", "delta", "delta_percent", "z_score", "outlier", "included", "eligible", "exclusion_reason", "alignment", "source_time_unit", "source_thrust_unit", "source_pressure_unit", "threshold_percent", "noise_window_s", "ignition_s", "burnout_s", "propellant_g", "noise_start_s", "noise_end_s"];
    columns.push("thrust_coverage_percent", ...SOURCE_REPORT_COLUMNS);
    const series = $("series-name").value.trim(), rows = [];
    const common = { series, alignment: settings.alignment, threshold_percent: settings.threshold, noise_window_s: settings.noiseWindow };
    for (const metric of SERIES_METRICS) {
      const stats = result.metrics[metric.key];
      rows.push({ ...common, row_type: "metric", metric: metric.key, metric_unit: unitFor(metric, { thrust: "N", pressure: "bar" }), ...stats, cv_percent: stats.cv });
    }
    for (const record of records) {
      const eligible = result.eligibleIds.includes(record.id), exclusion = result.excluded.find((item) => item.id === record.id);
      const base = { ...common, row_type: "test", profile: record.name, included: record.included, eligible,
        ...sourceReport(record), thrust_coverage_percent: Number.isFinite(record.stats?.coverage) ? record.stats.coverage * 100 : null,
        source_time_unit: record.sourceUnits.time, source_thrust_unit: record.sourceUnits.thrust, source_pressure_unit: record.sourceUnits.pressure,
        ignition_s: record.stats?.start, burnout_s: record.stats?.end, propellant_g: record.options.massKg == null ? null : record.options.massKg * 1000,
        noise_start_s: record.stats?.noiseStart, noise_end_s: record.stats?.noiseEnd,
        exclusion_reason: !record.included ? "Excluded by user" : exclusion?.reason.key ?? "" };
      if (!eligible) { rows.push(base); continue; }
      const values = result.deviations.find((item) => item.id === record.id)?.metrics ?? {};
      for (const metric of SERIES_METRICS) {
        const value = values[metric.key], stats = result.metrics[metric.key];
        rows.push({ ...base, metric: metric.key, metric_unit: unitFor(metric, { thrust: "N", pressure: "bar" }), n: stats.n, mean: stats.mean, sd: stats.sd,
          value: value?.value, delta: value?.delta, delta_percent: value?.percent, z_score: value?.z, outlier: value?.outlier ?? false });
      }
    }
    const textColumns = new Set(["series", "row_type", "metric", "metric_unit", "profile", "exclusion_reason", "alignment", "source_time_unit", "source_thrust_unit", "source_pressure_unit"]);
    textColumns.add("source_pressure_time_unit"); textColumns.add("source_marker_mode");
    const text = [columns.join(","), ...rows.map((row) => columns.map((key) => textColumns.has(key) ? csvText(row[key] ?? "") : typeof row[key] === "boolean" ? String(row[key]) : csvNumber(row[key])).join(","))].join("\r\n");
    downloadBlob(new Blob(["\uFEFF", text], { type: "text/csv;charset=utf-8" }), "flamesync-series-analysis.csv");
  }
  $("series-export").onclick = exportReport;
  return {
    update(nextResult, nextRecords, nextSettings) { result = nextResult; records = nextRecords; settings = nextSettings; render(); },
    settings: () => ({ band: $("series-band").value, showProfiles: $("series-show-profiles").checked }),
  };
}
