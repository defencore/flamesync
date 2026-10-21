import test from "node:test";
import assert from "node:assert/strict";
import { bindPageLifecycle } from "../src/page-lifecycle.js";

const pageEvent = (type, persisted) => Object.assign(new Event(type), { persisted });

test("history cache suspension preserves the editor and resumes it without disposing its sources", () => {
  const target = new EventTarget(), calls = [];
  bindPageLifecycle({ target, isExporting: () => false,
    suspend: () => calls.push("suspend"), resume: () => calls.push("resume"),
    dispose: () => calls.push("dispose") });
  target.dispatchEvent(pageEvent("pagehide", true));
  assert.deepEqual(calls, ["suspend"]);
  target.dispatchEvent(pageEvent("pageshow", true));
  assert.deepEqual(calls, ["suspend", "resume"]);
  target.dispatchEvent(pageEvent("pagehide", false));
  assert.deepEqual(calls, ["suspend", "resume", "suspend", "dispose"]);
  target.dispatchEvent(pageEvent("pageshow", true));
  target.dispatchEvent(pageEvent("pagehide", false));
  assert.equal(calls.length, 4, "A discarded page releases its resources once");
});

test("navigation warnings are registered only while an export is active", () => {
  class Page extends EventTarget {
    warnings = 0;
    addEventListener(type, ...args) { if (type === "beforeunload") this.warnings++; super.addEventListener(type, ...args); }
    removeEventListener(type, ...args) { if (type === "beforeunload") this.warnings--; super.removeEventListener(type, ...args); }
  }
  const target = new Page();
  let exporting = false;
  const lifecycle = bindPageLifecycle({ target, isExporting: () => exporting,
    suspend() {}, resume() {}, dispose() {} });
  assert.equal(target.warnings, 0);
  exporting = true; lifecycle.update(); lifecycle.update();
  assert.equal(target.warnings, 1);
  const active = new Event("beforeunload", { cancelable: true });
  Object.defineProperty(active, "returnValue", { value: undefined, writable: true });
  target.dispatchEvent(active);
  assert.equal(active.defaultPrevented, true);
  assert.equal(active.returnValue, "");
  exporting = false; lifecycle.update();
  assert.equal(target.warnings, 0);
  const idle = new Event("beforeunload", { cancelable: true });
  target.dispatchEvent(idle);
  assert.equal(idle.defaultPrevented, false);
});

test("unbinding the page lifecycle is idempotent and removes its active navigation warning", () => {
  const target = new EventTarget(), calls = [];
  const lifecycle = bindPageLifecycle({ target, isExporting: () => true,
    suspend: () => calls.push("suspend"), resume: () => calls.push("resume"), dispose: () => calls.push("dispose") });
  lifecycle.dispose(); lifecycle.dispose(); lifecycle.update();
  target.dispatchEvent(pageEvent("pagehide", true));
  target.dispatchEvent(pageEvent("pageshow", true));
  const idle = new Event("beforeunload", { cancelable: true });
  target.dispatchEvent(idle);
  assert.equal(idle.defaultPrevented, false);
  assert.deepEqual(calls, []);
});
