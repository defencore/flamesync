// @ts-check
/** @typedef {{key:string,values:Record<string,string|number>}} Message */
/** @param {string} key @param {Record<string,string|number>} values @returns {Message} */
export const message = (key, values = {}) => ({ key, values });
/** @param {string} template @param {Record<string,string|number>} values */
export function formatMessage(template, values = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!Object.hasOwn(values, key))
      throw new Error(`Missing message value: ${key}`);
    return String(values[key]);
  });
}
export class UserError extends Error {
  /** @param {string} key @param {Record<string,string|number>} values */
  constructor(key, values = {}) {
    super(formatMessage(key, values));
    this.userMessage = message(key, values);
  }
}
/** @param {unknown} error @returns {Message} */
export function errorMessage(error) {
  if (error instanceof UserError) return error.userMessage;
  return message("The operation could not be completed. {details}", {
    details: error instanceof Error ? error.message : String(error),
  });
}
