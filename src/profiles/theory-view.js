import { t } from "../i18n.js";
import { displayThrust, displayPressure } from "../units.js";
import { downloadBlob } from "../files.js";
import { number } from "./results.js";

export function theoryValues(record, theory) {
  const stats = record.stats, expected = theory.stats, difference = record.theoryDifference;
  const complete = stats?.coverage >= 1 - 1e-10;
  return {
    theoryImpulseChange: complete && expected?.coverage >= 1 - 1e-10 && expected.impulse > 0 && Number.isFinite(stats.impulse) ? (stats.impulse / expected.impulse - 1) * 100 : null,
    theoryDurationChange: stats?.duration > 0 && expected?.duration > 0 ? (stats.duration / expected.duration - 1) * 100 : null,
    theoryThrustRmse: difference?.thrust?.rmse ?? null,
    theoryPressureRmse: difference?.pressure?.rmse ?? null,
    theoryThrustBias: difference?.thrust?.bias ?? null,
    theoryCoverage: difference ? difference.coverage * 100 : null,
  };
}
export function renderTheoryComparison(records, theory, units, alignment, busy = false) {
  const active = theory?.enabled && theory.sourceValid && !theory.loading && theory.data;
  document.getElementById("profiles-theory-panel").hidden = !active;
  if (!active) return;
  document.getElementById("profiles-theory-name").textContent = theory.name;
  const table = document.getElementById("profiles-theory-results"), head = document.createElement("tr");
  const columns = [
    ["theoryImpulseChange", "Impulse versus theory", "%"],
    ["theoryDurationChange", "Duration versus theory", "%"],
    ["theoryThrustRmse", "Thrust RMSE", units.thrust, "thrust"],
    ["theoryPressureRmse", "Pressure RMSE", units.pressure, "pressure"],
    ["theoryThrustBias", "Mean thrust error", units.thrust, "thrust"],
    ["theoryCoverage", "Common interval coverage", "%"],
  ];
  const title = document.createElement("th"); title.scope = "col"; title.textContent = t("Profile"); head.append(title);
  for (const [, label, unit] of columns) { const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = `${t(label)} · ${unit}`; head.append(cell); }
  table.tHead.replaceChildren(head);
  const fragment = document.createDocumentFragment();
  for (const record of records) {
    const row = document.createElement("tr"), name = document.createElement("th"), values = theoryValues(record, theory);
    row.dataset.profileId = record.id; name.scope = "row"; name.textContent = record.name; name.title = record.name;
    name.style.borderLeft = `3px solid ${record.color}`; row.append(name);
    for (const [key, , , signal] of columns) {
      const cell = document.createElement("td"), value = values[key]; cell.dataset.stat = key;
      cell.dataset.value = Number.isFinite(value) ? String(value) : "";
      cell.textContent = number(!Number.isFinite(value) ? null : signal === "thrust" ? displayThrust(value, units.thrust) : signal === "pressure" ? displayPressure(value, units.pressure) : value);
      row.append(cell);
    }
    fragment.append(row);
  }
  table.tBodies[0].replaceChildren(fragment);
  const button = document.getElementById("profiles-theory-export"); button.disabled = busy || !records.length || records.some((record) => record.error);
  button.onclick = () => exportTheoryComparison(records, theory, alignment);
}
const quoted = (value) => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
const numeric = (value) => Number.isFinite(value) ? String(value) : "";
function exportTheoryComparison(records, theory, alignment) {
  const headers = ["profile", "theory", "alignment", "measured_impulse_Ns", "theory_impulse_Ns", "impulse_difference_percent", "measured_duration_s", "theory_duration_s", "duration_difference_percent", "thrust_rmse_N", "pressure_rmse_bar", "mean_thrust_error_N", "common_interval_coverage_percent"];
  const rows = records.map((record) => {
    const values = theoryValues(record, theory);
    return [quoted(record.name), quoted(theory.name), quoted(alignment), numeric(record.stats?.impulse), numeric(theory.stats.impulse), numeric(values.theoryImpulseChange),
      numeric(record.stats?.duration), numeric(theory.stats.duration), numeric(values.theoryDurationChange), numeric(values.theoryThrustRmse), numeric(values.theoryPressureRmse), numeric(values.theoryThrustBias), numeric(values.theoryCoverage)].join(",");
  });
  downloadBlob(new Blob(["\uFEFF", [headers.join(","), ...rows].join("\r\n")], { type: "text/csv;charset=utf-8" }), "flamesync-measured-versus-theory.csv");
}
