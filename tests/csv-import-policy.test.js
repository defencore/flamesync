import test from "node:test";
import assert from "node:assert/strict";
import { csvClockIdentity, csvEventIdentity } from "../src/csv-import-policy.js";

const settings = { timeUnit: "ms", columns: { thrustTime: 0, thrust: 1, pressureTime: 2, pressure: 3, markerMode: "active", active: 4 } };

test("pressure remapping and source force units preserve thrust synchronization and A/B", () => {
  const pressure = { ...settings, pressureTimeUnit: "us", pressureUnit: "psi", thrustUnit: "N",
    columns: { ...settings.columns, pressureTime: 5, pressure: 6 } };
  assert.equal(csvClockIdentity(settings), csvClockIdentity(pressure));
  assert.equal(csvEventIdentity(settings), csvEventIdentity(pressure));
});

test("a thrust clock change invalidates both synchronization and event selection", () => {
  for (const changed of [{ timeUnit: "us" }, { hasHeader: false }, { columns: { ...settings.columns, thrustTime: 5 } }]) {
    assert.notEqual(csvClockIdentity(settings), csvClockIdentity({ ...settings, ...changed }));
    assert.notEqual(csvEventIdentity(settings), csvEventIdentity({ ...settings, ...changed }));
  }
});

test("thrust values, sparse policy and event markers invalidate events without shifting the clock", () => {
  for (const changed of [{ allowSparse: true }, { columns: { ...settings.columns, thrust: 7 } }, { columns: { ...settings.columns, active: 5 } }]) {
    assert.equal(csvClockIdentity(settings), csvClockIdentity({ ...settings, ...changed }));
    assert.notEqual(csvEventIdentity(settings), csvEventIdentity({ ...settings, ...changed }));
  }
});

test("implicit CSV defaults do not trigger a false source identity change", () => {
  assert.equal(csvClockIdentity({}), csvClockIdentity({ timeUnit: "auto", hasHeader: true }));
  assert.equal(csvEventIdentity({}), csvEventIdentity({ timeUnit: "auto", hasHeader: true, allowSparse: false }));
});
