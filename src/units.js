// @ts-check
import { UserError } from "./messages.js";

// Parsed measurements use N and bar internally; conversion happens only at input and display.
export const THRUST_FACTORS = Object.freeze({
  N: 1,
  kN: 1000,
  kgf: 9.80665,
  gf: 0.00980665,
  lbf: 4.4482216152605,
});
export const PRESSURE_FACTORS = Object.freeze({
  Pa: 0.00001,
  kPa: 0.01,
  MPa: 10,
  bar: 1,
  psi: 4.4482216152605 / (0.0254 ** 2 * 100000),
  atm: 1.01325,
});
export const TIME_FACTORS = Object.freeze({ s: 1, ms: 0.001, us: 0.000001 });
/** @typedef {{timeUnit?:string,thrustUnit?:string,pressureUnit?:string}} CSVSettings */
/** @param {Record<string,number>} factors @param {string} unit */
function factor(factors, unit) {
  if (!Object.hasOwn(factors, unit))
    throw new UserError("Unsupported unit: {value0}.", { value0: unit });
  return factors[unit];
}
/** @param {string} unit */
export const thrustFactor = (unit) => factor(THRUST_FACTORS, unit);
/** @param {string} unit */
export const pressureFactor = (unit) => factor(PRESSURE_FACTORS, unit);
/** @param {string} unit */
export const timeFactor = (unit) => factor(TIME_FACTORS, unit);
/** @param {number} value @param {string} unit */
export const displayThrust = (value, unit) => value / thrustFactor(unit);
/** @param {number} value @param {string} unit */
export const displayPressure = (value, unit) => value / pressureFactor(unit);
/** @param {number} seconds @param {string} unit */
export function sourceTimestamp(seconds, unit) {
  const value = seconds / timeFactor(unit);
  return `${Number(value.toFixed(6))} ${unit === "us" ? "µs" : unit}`;
}
