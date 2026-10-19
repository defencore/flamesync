import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import ts from "typescript";
import { uk } from "../src/locales/uk.js";
import { t, renderMessage, getLocale } from "../src/i18n.js";
import {
  message,
  UserError,
  errorMessage,
  formatMessage,
} from "../src/messages.js";
import { parseCSV } from "../src/data.js";

const parameters = (text) =>
  [
    ...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1])),
  ].sort();

test("every Ukrainian translation preserves the source message parameters", () => {
  for (const [source, translation] of Object.entries(uk)) {
    assert.ok(translation.trim(), source);
    assert.deepEqual(parameters(translation), parameters(source), source);
  }
});

test("static interface text and attributes have Ukrainian translations", async () => {
  const html = await readFile(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  const decode = (value) =>
    value
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  const keys = [...html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]*)"/g)];
  assert.ok(keys.length > 300);
  for (const [, value] of keys)
    assert.ok(Object.hasOwn(uk, decode(value)), value);
});

test("dynamic interface messages and validation errors have translations", async () => {
  function check(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text) assert.ok(Object.hasOwn(uk, node.text), node.text);
    } else if (ts.isConditionalExpression(node)) {
      check(node.whenTrue);
      check(node.whenFalse);
    }
  }
  async function* sourceFiles(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "locales")
          yield* sourceFiles(new URL(`${entry.name}/`, directory));
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        yield new URL(entry.name, directory);
      }
    }
  }
  for await (const file of sourceFiles(new URL("../src/", import.meta.url))) {
    const source = ts.createSourceFile(
      file.pathname,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = node.expression.getText(source),
          args = node.arguments;
        if (args?.length) {
          if (["t", "message", "UserError", "editor.notice"].includes(name))
            check(args[0]);
          if (name === "bindText" && args[1]) check(args[1]);
          if (name === "bindAttribute" && args[2]) check(args[2]);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});

test("Ukrainian is the default and message values stay literal", () => {
  assert.equal(getLocale(), "uk");
  assert.equal(t("Save video"), "Зберегти відео");
  assert.equal(
    renderMessage([
      message("Unavailable"),
      message("{value} s", { value: "1.200" }),
    ]),
    "Недоступно 1.200 с",
  );
  assert.equal(
    t("{value} s", { value: "<script>user text</script>" }),
    "<script>user text</script> с",
  );
  assert.throws(
    () => t("A missing catalog entry"),
    /Missing Ukrainian translation/,
  );
  assert.throws(() => formatMessage("{required}", {}), /Missing message value/);
});

test("worker validation retains diagnostic errors and translates physical CSV line numbers", () => {
  let failure;
  try {
    parseCSV("time_ms;thrust;pressure\n0;0;0\n0;1;1");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof UserError);
  assert.match(failure.message, /Line 3: timestamps must increase strictly/);
  assert.match(
    renderMessage(errorMessage(failure)),
    /Рядок 3: часові мітки мають зростати/,
  );
  assert.match(
    renderMessage(errorMessage(new Error("Decoder detail"))),
    /Decoder detail/,
  );
});
