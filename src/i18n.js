import { uk } from "./locales/uk.js";
import { formatMessage, message } from "./messages.js";

let locale = "uk";
const texts = new Map();
const attributes = new Map();
export const getLocale = () => locale;
export function t(key, values = {}) {
  if (!key) return "";
  const template = locale === "en" ? key : uk[key];
  if (template === undefined)
    throw new Error(`Missing Ukrainian translation: ${key}`);
  return formatMessage(template, values);
}
export function renderMessage(value) {
  if (Array.isArray(value)) return value.map(renderMessage).join(" ");
  if (typeof value === "string") return t(value);
  return t(value.key, value.values);
}
function element(target) {
  return typeof target === "string" ? document.getElementById(target) : target;
}
export function bindText(target, key, values = {}) {
  const node = element(target);
  const value = typeof key === "string" ? message(key, values) : key;
  texts.set(node, value);
  const text = renderMessage(value);
  if (node.textContent !== text) node.textContent = text;
}
export function bindAttribute(target, attribute, key, values = {}) {
  const node = element(target);
  if (!attributes.has(node)) attributes.set(node, new Map());
  attributes.get(node).set(attribute, message(key, values));
  node.setAttribute(attribute, t(key, values));
}
function applyLocale() {
  document.documentElement.lang = locale;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.getAttribute("data-i18n"));
  });
  for (const attribute of ["title", "aria-label", "placeholder", "data-help"]) {
    document.querySelectorAll(`[data-i18n-${attribute}]`).forEach((node) => {
      node.setAttribute(
        attribute,
        t(node.getAttribute(`data-i18n-${attribute}`)),
      );
    });
  }
  for (const [node, value] of texts) {
    if (!node.isConnected) texts.delete(node);
    else node.textContent = renderMessage(value);
  }
  for (const [node, values] of attributes) {
    if (!node.isConnected) attributes.delete(node);
    else
      for (const [attribute, value] of values)
        node.setAttribute(attribute, renderMessage(value));
  }
  document.getElementById("language-select").value = locale;
}
export function setLocale(value) {
  if (!["uk", "en"].includes(value))
    throw new Error(`Unsupported interface language: ${value}`);
  locale = value;
  try {
    localStorage.setItem("flamesync.language", locale);
  } catch {
    /* The editor also works when preferences cannot be stored. */
  }
  applyLocale();
  document.dispatchEvent(new CustomEvent("flamesync:language"));
}
export function initializeLanguage() {
  try {
    const stored = localStorage.getItem("flamesync.language");
    if (stored === "en" || stored === "uk") locale = stored;
  } catch {
    /* Language storage is optional. */
  }
  applyLocale();
  document
    .getElementById("language-select")
    .addEventListener("change", (event) => setLocale(event.target.value));
}
