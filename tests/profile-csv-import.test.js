import test from "node:test";
import assert from "node:assert/strict";
import { createProfileCSVImports } from "../src/profiles/csv-import.js";

const source = (name, content = "clock;force;chamber\n0;0;0\n1;10;2") => new File([content], name);
const defaults = { timeUnit: "auto", thrustUnit: "kgf", pressureUnit: "bar" };
const mapped = { ...defaults, timeUnit: "s", hasHeader: true,
  columns: { thrustTime: 0, thrust: 1, pressureTime: null, pressure: 2, markerMode: "none" } };

function harness() {
  const calls = [];
  const imports = createProfileCSVImports(async (file, settings, options) => {
    calls.push({ file, settings, options }); return structuredClone(mapped);
  });
  return { imports, calls };
}

test("matching custom schemas reuse one selection in a batch and subsequent imports", async () => {
  const { imports, calls } = harness(), batch = imports.batch();
  const first = source("a.csv"), second = source("b.csv"), third = source("c.csv");
  const choice = await batch.configure(first, defaults); await batch.remember(first, choice);
  const reused = await batch.configure(second, defaults);
  assert.equal(calls.length, 1); assert.deepEqual(reused, mapped);
  reused.columns.thrust = 2; assert.equal(choice.columns.thrust, 1);
  await imports.remember(first, choice);
  assert.deepEqual(await imports.batch().configure(third, defaults), mapped); assert.equal(calls.length, 1);
  await imports.batch().configure(source("different.csv", "a;b;c\n0;1;2\n1;2;3"), defaults);
  assert.equal(calls.length, 2);
});

test("standard CSV always follows current default units despite a manual custom override", async () => {
  const { imports, calls } = harness();
  const standard = source("standard.csv", "time_ms;thrust;pressure\n0;1;2\n1000;2;3");
  await imports.remember(standard, { ...mapped, thrustUnit: "N" });
  await imports.batch().configure(standard, defaults);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].settings, defaults);
  const forcedBatch = imports.batch({ custom: true });
  const overridden = { ...mapped, thrustUnit: "N" };
  await forcedBatch.remember(standard, overridden);
  assert.deepEqual(await forcedBatch.configure(standard, defaults), overridden);
  assert.equal(calls.length, 1);
  await imports.batch().configure(standard, defaults); assert.equal(calls.length, 2);
});

test("headerless schema reuse stays in its selected batch and never treats a header row as data", async () => {
  const { imports, calls } = harness(), batch = imports.batch();
  const first = source("one.csv", "0;0;0\n1;10;2"), second = source("two.csv", "0;1;0\n1;12;2");
  const choice = { ...mapped, hasHeader: false };
  await batch.remember(first, choice);
  assert.deepEqual(await batch.configure(second, defaults), choice); assert.equal(calls.length, 0);
  await imports.remember(first, choice);
  await imports.batch().configure(second, defaults); assert.equal(calls.length, 1);
  await batch.configure(source("header.csv"), defaults); assert.equal(calls.length, 2);
});

test("clearing import settings discards custom templates and isolated demos cannot consume them", async () => {
  const { imports, calls } = harness(), first = source("one.csv");
  await imports.remember(first, mapped);
  await imports.batch({ isolated: true }).configure(source("isolated.csv"), defaults); assert.equal(calls.length, 1);
  imports.clear(); await imports.batch().configure(source("next.csv"), defaults); assert.equal(calls.length, 2);
});

test("a cancelled batch rejects before reading or opening another CSV selection", async () => {
  const { imports, calls } = harness(), cancel = new AbortController(); cancel.abort();
  await assert.rejects(imports.batch().configure(source("cancelled.csv"), defaults, { signal: cancel.signal }), { name: "AbortError" });
  assert.equal(calls.length, 0);
});
