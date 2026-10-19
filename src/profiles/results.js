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
export function exportResults(records, reference, alignment, settings) {
  const headers = ["profile", "ignition_s", "burnout_s", "duration_s", "impulse_Ns", "mean_thrust_N", "peak_thrust_N", "peak_pressure_bar", "noise_thrust_rms_N", "noise_pressure_rms_bar", "noise_thrust_percent", "specific_impulse_s", "coverage_percent", "rmse_N", "mean_difference_N", "rmse_bar", "mean_difference_bar", "noise_start_s", "noise_end_s", "propellant_g", "reference_profile", "alignment"];
  const fields = ["start", "end", "duration", "impulse", "meanThrust", "peakThrust", "peakPressure", "noiseThrustRms", "noisePressureRms", "noiseThrustPercent", "specificImpulse"];
  headers.push("threshold_percent", "noise_window_s", "source_time_unit", "source_thrust_unit", "source_pressure_unit");
  const lines = records.map((record) => {
    const stats = record.stats ?? {}, diff = record.difference;
    return [csvText(record.name), ...fields.map((key) => csvNumber(stats[key])),
      csvNumber(Number.isFinite(stats.coverage) ? stats.coverage * 100 : null),
      csvNumber(diff?.thrust.rmse), csvNumber(diff?.thrust.bias), csvNumber(diff?.pressure.rmse), csvNumber(diff?.pressure.bias),
      csvNumber(stats.noiseStart), csvNumber(stats.noiseEnd), csvNumber(record.options.massKg == null ? null : record.options.massKg * 1000),
      csvText(reference?.name ?? ""), csvText(alignment), csvNumber(settings.threshold), csvNumber(settings.noiseWindow),
      csvText(record.sourceUnits.time), csvText(record.sourceUnits.thrust), csvText(record.sourceUnits.pressure)].join(",");
  });
  downloadBlob(new Blob(["\uFEFF", [headers.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" }), "flamesync-profile-comparison.csv");
}
