import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerClient } from "../src/worker-client.js";

function harness() {
  const workers = [];
  const client = createWorkerClient(() => {
    const worker = { messages: [], terminated: false,
      postMessage(payload) { this.messages.push(payload); },
      terminate() { this.terminated = true; },
      respond(requestId, result) { this.onmessage({ data: { requestId, result } }); },
    };
    workers.push(worker); return worker;
  });
  return { client, workers };
}

test("worker requests are lazy, identified, and settle independently out of order", async () => {
  const { client, workers } = harness();
  assert.equal(workers.length, 0);
  const first = client.request({ type: "import" }), second = client.request({ type: "sample" });
  assert.equal(workers.length, 1);
  workers[0].respond(2, "sample"); workers[0].respond(1, "import");
  workers[0].respond(1, "duplicate ignored");
  assert.equal(await first, "import"); assert.equal(await second, "sample");
  client.dispose();
});

test("worker reset cancels all pending requests and ignores callbacks from its previous generation", async () => {
  const { client, workers } = harness();
  const first = client.request({}), second = client.request({});
  const rejections = [assert.rejects(first, { name: "AbortError" }), assert.rejects(second, { name: "AbortError" })];
  client.reset(); await Promise.all(rejections);
  assert.equal(workers[0].terminated, true);
  const third = client.request({});
  workers[0].respond(3, "stale"); workers[0].onerror({ message: "stale error" });
  assert.equal(workers[1].terminated, false);
  workers[1].respond(3, "current"); assert.equal(await third, "current");
  client.dispose();
});

test("worker errors keep localized user messages and cannot strand concurrent requests", async () => {
  const { client, workers } = harness();
  const first = client.request({});
  workers[0].onmessage({ data: { requestId: 1, error: { key: "Unsupported unit: {value0}.", values: { value0: "bad" } } } });
  await assert.rejects(first, (error) => error.userMessage?.values.value0 === "bad");
  const second = client.request({}), third = client.request({});
  const rejections = [assert.rejects(second, /decoder failed/), assert.rejects(third, /decoder failed/)];
  let prevented = false;
  workers[0].onerror({ message: "decoder failed", preventDefault() { prevented = true; } });
  await Promise.all(rejections); assert.equal(prevented, true);
  const fourth = client.request({}); workers[1].respond(4, 4);
  assert.equal(await fourth, 4); client.dispose();
});

test("unreadable worker messages fail pending work and release the broken worker", async () => {
  const { client, workers } = harness();
  const request = client.request({}); const rejected = assert.rejects(request, /unreadable/);
  workers[0].onmessageerror(); await rejected;
  assert.equal(workers[0].terminated, true); client.dispose();
});

test("worker creation and clone errors reject without retaining ghost requests", async () => {
  let attempts = 0;
  const creation = createWorkerClient(() => { attempts++; throw new Error("cannot create"); });
  await assert.rejects(creation.request({}), /cannot create/);
  await assert.rejects(creation.request({}), /cannot create/);
  assert.equal(attempts, 2); creation.dispose();

  const { client, workers } = harness();
  const first = client.request({});
  const original = workers[0].postMessage;
  workers[0].postMessage = () => { throw new DOMException("Cannot clone source", "DataCloneError"); };
  await assert.rejects(client.request({}), { name: "DataCloneError" });
  workers[0].postMessage = original;
  workers[0].respond(1, "still pending"); assert.equal(await first, "still pending");
  const last = client.request({}); workers[0].respond(3, "next request");
  assert.equal(await last, "next request"); client.dispose();
});

test("disposing a worker is terminal and cannot restart it", async () => {
  const { client, workers } = harness();
  client.dispose(); await assert.rejects(client.request({}), { name: "AbortError" });
  assert.equal(workers.length, 0);
});
