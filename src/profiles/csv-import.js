// @ts-check
import { inspectCSV, csvNumber } from "../csv-format.js";

/** @typedef {import("../units.js").CSVSettings} CSVSettings */
/** @typedef {import("../units.js").CSVColumns} CSVColumns */
/** @typedef {{headers:string[],rows:{values:string[],line:number}[],delimiter:string,automatic:CSVColumns|null,schema:string}} InspectedSchema */
/** @typedef {{force?:boolean,signal?:AbortSignal}} ConfigureOptions */
/** @typedef {(file:File,settings:CSVSettings,options:ConfigureOptions)=>Promise<CSVSettings|null>} ConfigureCSV */

const PREVIEW_BYTES = 128 * 1024;
/** @param {CSVSettings} settings @returns {CSVSettings} */
const cloneSettings = (settings) => ({ ...settings, ...(settings.columns ? { columns: { ...settings.columns } } : {}) });

/** Keep custom schemas local to the workspace and deliberate overrides local to their batch.
 * @param {ConfigureCSV} configureCSV
 */
export function createProfileCSVImports(configureCSV) {
  /** @type {Map<string,CSVSettings>} */
  const templates = new Map();
  /** @type {WeakMap<File,Map<boolean,InspectedSchema>>} */
  const schemas = new WeakMap();

  /** @param {File} file @param {boolean} hasHeader @returns {Promise<InspectedSchema>} */
  async function inspect(file, hasHeader) {
    let cached = schemas.get(file);
    if (!cached) { cached = new Map(); schemas.set(file, cached); }
    if (!cached.has(hasHeader)) {
      const inspected = inspectCSV(await file.slice(0, PREVIEW_BYTES).text(), { hasHeader });
      cached.set(hasHeader, { ...inspected, schema: JSON.stringify([hasHeader, inspected.delimiter, inspected.headers]) });
    }
    return /** @type {InspectedSchema} */ (cached.get(hasHeader));
  }

  /** @param {File} file @param {CSVSettings} settings @param {Map<string,CSVSettings>} [target] */
  async function remember(file, settings, target = templates) {
    if (!settings.columns) return;
    const inspected = await inspect(file, settings.hasHeader !== false);
    if (target === templates && (settings.hasHeader === false || inspected.automatic)) return;
    target.set(inspected.schema, cloneSettings(settings));
  }

  /** @param {InspectedSchema} inspected @param {CSVColumns} columns */
  function headerlessValuesMatch(inspected, columns) {
    const selected = [columns.thrustTime, columns.thrust,
      ...(columns.pressure === null ? [] : [columns.pressureTime ?? columns.thrustTime, columns.pressure])];
    const first = inspected.rows[0]?.values;
    return first && selected.some((index) => first[index] !== "") &&
      selected.every((index) => first[index] === "" || Number.isFinite(csvNumber(first[index], inspected.delimiter)));
  }

  return {
    clear() { templates.clear(); },
    remember,
    /** @param {{isolated?:boolean,custom?:boolean}} [options] */
    batch({ isolated = false, custom = false } = {}) {
      const batchTemplates = isolated ? new Map() : new Map(templates);
      return {
        /** @param {File} file @param {CSVSettings} defaults @param {ConfigureOptions} [options] */
        async configure(file, defaults, { force = false, signal } = {}) {
          signal?.throwIfAborted();
          if (!force && !defaults.columns) {
            const standard = await inspect(file, true);
            signal?.throwIfAborted();
            if (standard.automatic && !custom) return configureCSV(file, defaults, { signal });
            for (const [schema, settings] of batchTemplates) {
              if (!settings.columns) continue;
              const inspected = await inspect(file, settings.hasHeader !== false);
              signal?.throwIfAborted();
              if (inspected.schema !== schema || settings.hasHeader === false && !headerlessValuesMatch(inspected, settings.columns)) continue;
              return cloneSettings(settings);
            }
          }
          return configureCSV(file, defaults, { force, signal });
        },
        /** @param {File} file @param {CSVSettings} settings */
        remember(file, settings) { return remember(file, settings, batchTemplates); },
      };
    },
  };
}
