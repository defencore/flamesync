import test from "node:test";
import assert from "node:assert/strict";
import { readVideoMetadata } from "../src/video-metadata.js";

function probe() {
  return { duration: 4, videoWidth: 1920, videoHeight: 1080, loads: 0, removed: [],
    removeAttribute(name) { this.removed.push(name); }, load() { this.loads++; } };
}

test("video metadata validates its source and releases the temporary probe after success", async () => {
  const video = probe(), request = readVideoMetadata("blob:source", { createVideo: () => video });
  assert.equal(video.src, "blob:source"); video.onloadedmetadata();
  assert.deepEqual(await request, { duration: 4, width: 1920, height: 1080 });
  assert.deepEqual(video.removed, ["src"]); assert.equal(video.loads, 1);
  assert.equal(video.onloadedmetadata, null); assert.equal(video.onerror, null);
});

test("an aborted video import releases its probe immediately and ignores late metadata", async () => {
  const video = probe(), cancel = new AbortController();
  const request = readVideoMetadata("blob:source", { createVideo: () => video, signal: cancel.signal });
  const lateMetadata = video.onloadedmetadata, rejected = assert.rejects(request, { name: "AbortError" });
  cancel.abort(); await rejected; lateMetadata(); assert.equal(video.loads, 1);
});

test("invalid or unplayable video metadata cannot replace the active source", async () => {
  const invalid = probe(); invalid.duration = Infinity;
  const request = readVideoMetadata("blob:invalid", { createVideo: () => invalid }); invalid.onloadedmetadata();
  await assert.rejects(request, /finite duration/); assert.equal(invalid.loads, 1);
  const broken = probe(), error = readVideoMetadata("blob:broken", { createVideo: () => broken }); broken.onerror();
  await assert.rejects(error, /cannot play/); assert.equal(broken.loads, 1);
});

test("a metadata timeout releases the probe and a pre-aborted import never creates one", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const video = probe(), request = readVideoMetadata("blob:timeout", { createVideo: () => video });
  const rejected = assert.rejects(request, /metadata could not be read/);
  context.mock.timers.tick(20000); await rejected; assert.equal(video.loads, 1);
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(readVideoMetadata("blob:cancelled", { signal: cancel.signal, createVideo: () => { throw new Error("must not create"); } }), { name: "AbortError" });
});
