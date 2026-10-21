// @ts-check
/** Only changes to the thrust clock invalidate video synchronization.
 * @param {import("./units.js").CSVSettings} settings
 */
export function csvClockIdentity(settings) {
  return JSON.stringify([
    settings.timeUnit ?? "auto", settings.hasHeader !== false,
    settings.columns?.thrustTime ?? null,
  ]);
}

/** Pressure configuration never invalidates thrust events or manual A/B edits.
 * @param {import("./units.js").CSVSettings} settings
 */
export function csvEventIdentity(settings) {
  const columns = settings.columns;
  return JSON.stringify([
    csvClockIdentity(settings), settings.allowSparse ?? false,
    columns?.thrust ?? null, columns?.markerMode ?? "none",
    columns?.active ?? null, columns?.start ?? null, columns?.end ?? null,
  ]);
}
