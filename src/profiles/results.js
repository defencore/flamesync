import { t, getLocale } from "../i18n.js";
import { displayPressure, displayThrust } from "../units.js";
import { downloadBlob } from "../files.js";

export const number = (value, digits = 3) => Number.isFinite(value)
  ? value.toLocaleString(getLocale() === "uk" ? "uk-UA" : "en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }) : "—";

export function renderResults(records, reference, units, metric) {
  const table = document.getElementById("profiles-table");
  const columns = [
    ["duration", "Burn duration", "s"], ["impulse", "Total impulse", `${units.thrust}·s`, "thrust"],
    ["meanThrust", "Mean thrust", units.thrust, "thrust"], ["peakThrust", "Peak thrust", units.thrust, "thrust"],
    ["peakPressure", "Peak pressure", units.pressure, "pressure"],
    ["noiseThrustRms", "Thrust residual RMS", units.thrust, "thrust"],
    ["noisePressureRms", "Pressure residual RMS", units.pressure, "pressure"],
    ["noiseThrustPercent", "Relative thrust residual", "%"],
    ["specificImpulse", "Specific impulse", "s"], ["coverage", "Data coverage", "%"],
    ["impulseChange", "Impulse vs reference", "%"],
    ["rmse", "Difference RMSE", units[metric], metric],
    ["bias", "Mean difference", units[metric], metric],
  ];
  const head = document.createElement("tr"), first = document.createElement("th");
  first.textContent = t("Profile"); first.scope = "col"; head.append(first);
  for (const [, label, unit] of columns) {
    const cell = document.createElement("th"); cell.scope = "col";
    cell.append(document.createTextNode(t(label)), document.createElement("br"), document.createTextNode(unit));
    head.append(cell);
  }
  table.tHead.replaceChildren(head);
  const fragment = document.createDocumentFragment();
  for (const record of records) {
    const row = document.createElement("tr"); row.dataset.profileId = record.id;
    const name = document.createElement("th"); name.scope = "row"; name.textContent = record.name;
    name.title = record.name; name.style.borderLeft = `3px solid ${record.color}`; row.append(name);
    const stats = record.stats ?? {};
    const values = { ...stats,
      coverage: Number.isFinite(stats.coverage) ? stats.coverage * 100 : null,
      impulseChange: reference?.stats?.impulse > 0 && Number.isFinite(stats.impulse)
        ? (stats.impulse / reference.stats.impulse - 1) * 100 : null,
      rmse: record.difference?.[metric].rmse ?? null,
      bias: record.difference?.[metric].bias ?? null,
    };
    for (const [key, , , convert] of columns) {
      const cell = document.createElement("td"), value = values[key];
      cell.dataset.stat = key; cell.dataset.value = Number.isFinite(value) ? String(value) : "";
      cell.textContent = number(!Number.isFinite(value) ? null : convert === "thrust"
        ? displayThrust(value, units.thrust) : convert === "pressure" ? displayPressure(value, units.pressure) : value,
      ["coverage", "impulseChange", "noiseThrustPercent"].includes(key) ? 2 : 3);
      row.append(cell);
    }
    fragment.append(row);
  }
  table.tBodies[0].replaceChildren(fragment);
  document.getElementById("profiles-results-empty").hidden = !!records.length;
}

// Text fields are quoted and formula-prefixed names are neutralized for sheets.
const csvText = (value) => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
const csvNumber = (value) => Number.isFinite(value) ? String(value) : "";
export const SOURCE_REPORT_COLUMNS = ["source_pressure_time_unit", "thrust_samples", "pressure_samples",
  "thrust_time_start_s", "thrust_time_end_s", "pressure_time_start_s", "pressure_time_end_s",
  "pressure_coverage_percent", "source_has_header", "source_allow_sparse", "source_thrust_time_column",
  "source_thrust_column", "source_pressure_time_column", "source_pressure_column", "source_marker_mode",
  "source_active_column", "source_ignition_column", "source_burnout_column"];
// Column indices in reports are one-based, matching the mapping dialog labels.
export function sourceReport(record) {
  const columns = record.columnMapping ?? record.settings?.columns ?? {};
  const index = (value) => Number.isInteger(value) ? value + 1 : null;
  return { source_pressure_time_unit: record.sourceUnits.pressureTime ?? record.sourceUnits.time,
    thrust_samples: record.count, pressure_samples: record.pressureCount ?? 0,
    thrust_time_start_s: record.channels?.thrust.start ?? record.start,
    thrust_time_end_s: record.channels?.thrust.end ?? record.end,
    pressure_time_start_s: record.channels?.pressure.start, pressure_time_end_s: record.channels?.pressure.end,
    pressure_coverage_percent: Number.isFinite(record.stats?.pressureCoverage) ? record.stats.pressureCoverage * 100 : null,
    source_has_header: record.hasHeader ?? record.settings?.hasHeader !== false,
    source_allow_sparse: Boolean(record.settings?.allowSparse),
    source_thrust_time_column: index(columns.thrustTime), source_thrust_column: index(columns.thrust),
    source_pressure_time_column: columns.pressure == null ? null : index(columns.pressureTime ?? columns.thrustTime),
    source_pressure_column: index(columns.pressure), source_marker_mode: columns.markerMode ?? "none",
    source_active_column: columns.markerMode === "active" ? index(columns.active) : null,
    source_ignition_column: columns.markerMode === "events" ? index(columns.start) : null,
    source_burnout_column: columns.markerMode === "events" ? index(columns.end) : null };
}
const csvSourceValue = (value) => typeof value === "string" ? csvText(value)
  : typeof value === "boolean" ? String(value) : csvNumber(value);
export function exportResults(records, reference, alignment, settings) {
  const headers = ["profile", "ignition_s", "burnout_s", "duration_s", "impulse_Ns", "mean_thrust_N", "peak_thrust_N", "peak_pressure_bar", "noise_thrust_rms_N", "noise_pressure_rms_bar", "noise_thrust_percent", "specific_impulse_s", "coverage_percent", "rmse_N", "mean_difference_N", "rmse_bar", "mean_difference_bar", "noise_start_s", "noise_end_s", "propellant_g", "reference_profile", "alignment"];
  const fields = ["start", "end", "duration", "impulse", "meanThrust", "peakThrust", "peakPressure", "noiseThrustRms", "noisePressureRms", "noiseThrustPercent", "specificImpulse"];
  headers.push("threshold_percent", "noise_window_s", "source_time_unit", "source_thrust_unit", "source_pressure_unit");
  headers.push(...SOURCE_REPORT_COLUMNS);
  const lines = records.map((record) => {
    const stats = record.stats ?? {}, diff = record.difference, source = sourceReport(record);
    return [csvText(record.name), ...fields.map((key) => csvNumber(stats[key])),
      csvNumber(Number.isFinite(stats.coverage) ? stats.coverage * 100 : null),
      csvNumber(diff?.thrust.rmse), csvNumber(diff?.thrust.bias), csvNumber(diff?.pressure.rmse), csvNumber(diff?.pressure.bias),
      csvNumber(stats.noiseStart), csvNumber(stats.noiseEnd), csvNumber(record.options.massKg == null ? null : record.options.massKg * 1000),
      csvText(reference?.name ?? ""), csvText(alignment), csvNumber(settings.threshold), csvNumber(settings.noiseWindow),
      csvText(record.sourceUnits.time), csvText(record.sourceUnits.thrust), csvText(record.sourceUnits.pressure),
      ...SOURCE_REPORT_COLUMNS.map((key) => csvSourceValue(source[key]))].join(",");
  });
  downloadBlob(new Blob(["\uFEFF", [headers.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" }), "flamesync-profile-comparison.csv");
}
