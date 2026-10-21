import test from "node:test";
import assert from "node:assert/strict";

// A minimal DOM keeps these tests focused on asynchronous job ownership.
class Element extends EventTarget {
  value = "";
  textContent = "";
  onclick = null;
  open = false;
  clicks = 0;
  checked = false;
  hidden = false;
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { this.clicks++; this.onclick?.(); }
}

class WorkerDouble {
  static instances = [];
  static constructionError = false;
  static postError = false;
  terminated = false;
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  constructor() {
    if (WorkerDouble.constructionError) throw new Error("Worker unavailable");
    WorkerDouble.instances.push(this);
  }
  postMessage(job) {
    if (WorkerDouble.postError) throw new Error("Job could not be cloned");
    this.job = job;
  }
  terminate() { this.terminated = true; }
  send(data) { this.onmessage?.({ data }); }
}

test("media controller jobs recover from setup errors and reject stale workers", async (suite) => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const globals = {
    document: globalThis.document,
    Worker: globalThis.Worker,
    VideoEncoder: globalThis.VideoEncoder,
    OffscreenCanvas: globalThis.OffscreenCanvas,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  globalThis.document = {
    getElementById: element,
    querySelectorAll: () => [element("save-video")],
  };
  globalThis.Worker = WorkerDouble;
  globalThis.VideoEncoder = class {};
  globalThis.OffscreenCanvas = class {};
  let objectURLs = 0;
  URL.createObjectURL = () => `blob:test-${++objectURLs}`;
  URL.revokeObjectURL = () => {};
  suite.after(() => {
    for (const key of ["document", "Worker", "VideoEncoder", "OffscreenCanvas"])
      if (globals[key] === undefined) delete globalThis[key];
      else globalThis[key] = globals[key];
    URL.createObjectURL = globals.createObjectURL;
    URL.revokeObjectURL = globals.revokeObjectURL;
  });
  const { createExportController } = await import("../src/export-controller.js");
  const { createVideoInfoController } = await import("../src/video-info-controller.js");
  function harness() {
    WorkerDouble.instances = [];
    WorkerDouble.constructionError = WorkerDouble.postError = false;
    for (const node of elements.values()) {
      node.clicks = 0;
      node.open = false;
      node.onclick = null;
    }
    element("export-format").value = "mp4";
    element("export-quality").value = "very-high";
    element("export-resolution").value = "1920";
    element("export-fps").value = "0";
    element("keep-audio").checked = true;
    const notices = [];
    const state = {
      file: { name: "test-video.mp4" },
      csvFile: { name: "test-log.csv" },
      data: { overallStart: 0, overallEnd: 1 },
      style: { frameAspect: "16:9" },
      metadata: {},
      measurement: null,
      offset: 0,
      timeScale: 1,
      start: 0,
      end: 1,
      duration: 1,
      width: 1920,
      height: 1080,
      exporting: false,
      worker: null,
      timingWorker: null,
      exportURL: null,
    };
    const editor = {
      state,
      video: { pause() {} },
      refreshes: 0,
      refresh() { this.refreshes++; },
      notice: (...args) => notices.push(args),
      videoInfo: { source: () => ({ timestamps: new Float64Array([0]) }) },
      measurements: { composition: () => null },
    };
    return { state, editor, notices, save: () => element("save-video").click() };
  }

  {
    await suite.test("export waits for the native source frame index before taking its snapshot", () => {
      const { state, editor, save } = harness();
      const controller = createExportController(editor);
      try {
        state.timingWorker = { terminate() {} };
        save();
        assert.equal(state.exporting, false);
        assert.equal(state.worker, null);
        assert.equal(WorkerDouble.instances.length, 0);
        assert.equal(element("export-dialog").open, false);
        const timestamps = new Float64Array([0, 0.5]);
        editor.videoInfo.source = () => ({ timestamps });
        state.timingWorker = null;
        save();
        assert.equal(state.exporting, true);
        assert.deepEqual(state.worker.job.sourceInfo.timestamps, timestamps);
      } finally { controller.dispose(); }
    });

    for (const fault of ["constructionError", "postError"])
      await suite.test(`export releases its modal and controls after ${fault}`, () => {
        const { state, editor, notices, save } = harness();
        const controller = createExportController(editor);
        try {
          WorkerDouble[fault] = true;
          save();
          assert.equal(state.exporting, false);
          assert.equal(state.worker, null);
          assert.equal(element("export-dialog").open, false);
          assert.equal(notices.at(-1)[1], "error");
          if (WorkerDouble.instances.length)
            assert.equal(WorkerDouble.instances[0].terminated, true);
          WorkerDouble[fault] = false;
          save();
          assert.equal(state.exporting, true);
          assert.equal(element("export-dialog").open, true);
          assert.equal(state.worker.job.format, "mp4");
          assert.equal(state.worker.job.maxEdge, 1920);
          assert.equal(state.worker.job.quality, "very-high");
        } finally { controller.dispose(); }
      });

    await suite.test("canceling one export cannot complete or fail its replacement", () => {
      const { state, editor, notices, save } = harness();
      const controller = createExportController(editor);
      try {
        save();
        const previous = state.worker;
        const lateMessage = previous.onmessage;
        const lateError = previous.onerror;
        element("cancel-export").click();
        assert.equal(previous.terminated, true);
        assert.equal(state.exporting, false);
        save();
        const current = state.worker;
        const count = notices.length;
        lateMessage({ data: { type: "done", buffer: new ArrayBuffer(8) } });
        lateError({ message: "Old codec error", preventDefault() {} });
        assert.equal(state.worker, current);
        assert.equal(state.exporting, true);
        assert.equal(current.terminated, false);
        assert.equal(state.exportURL, null);
        assert.equal(element("download-again").clicks, 0);
        assert.equal(notices.length, count);
        current.send({ type: "done", buffer: new ArrayBuffer(8) });
        assert.equal(state.exporting, false);
        assert.equal(state.worker, null);
        assert.equal(current.terminated, true);
        assert.equal(element("download-again").clicks, 1);
        assert.equal(element("download-again").download, "test-video-flamesync.mp4");
      } finally { controller.dispose(); }
    });

    await suite.test("an unreadable export response recovers without blocking a retry", () => {
      const { state, editor, notices, save } = harness();
      const controller = createExportController(editor);
      try {
        save();
        state.worker.onmessageerror();
        assert.equal(state.exporting, false);
        assert.equal(state.worker, null);
        assert.equal(element("export-dialog").open, false);
        assert.equal(notices.at(-1)[1], "error");
        save();
        assert.equal(state.exporting, true);
      } finally { controller.dispose(); }
    });

    await suite.test("disposing an active export releases the worker without refreshing disposed UI", () => {
      const { state, editor, save } = harness();
      const controller = createExportController(editor);
      save();
      const worker = state.worker;
      const count = editor.refreshes;
      controller.dispose();
      assert.equal(worker.terminated, true);
      assert.equal(state.worker, null);
      assert.equal(state.exporting, false);
      assert.equal(element("export-dialog").open, false);
      assert.equal(element("save-video").onclick, null);
      assert.equal(editor.refreshes, count);
    });

    await suite.test("a superseded inspection of the same File cannot replace its newer index", () => {
      const { state, editor } = harness();
      const controller = createVideoInfoController(editor);
      try {
        controller.inspect(state.file);
        const previous = state.timingWorker;
        const lateMessage = previous.onmessage;
        controller.inspect(state.file);
        const current = state.timingWorker;
        lateMessage({ data: { type: "error", error: { key: "Unavailable", values: {} } } });
        assert.equal(state.timingWorker, current);
        assert.notEqual(state.timingError, true);
        current.send({
          type: "done",
          timing: { fps: 60, variable: false, frameCount: 2, end: 1 / 30 },
          timestamps: new Float64Array([0, 1 / 60]).buffer,
        });
        assert.equal(state.fps, 60);
        assert.equal(state.timingWorker, null);
        assert.equal(state.timingError, false);
        assert.deepEqual([...state.frameTimes], [0, 1 / 60]);
        const index = state.frameTimes;
        lateMessage({ data: { type: "done", timing: { fps: 30 }, timestamps: new Float64Array([0]).buffer } });
        assert.equal(state.frameTimes, index);
        assert.equal(state.fps, 60);
      } finally { controller.dispose(); }
    });

    for (const fault of ["constructionError", "postError"])
      await suite.test(`frame inspection reports ${fault} and can retry`, () => {
        const { state, editor } = harness();
        const controller = createVideoInfoController(editor);
        try {
          WorkerDouble[fault] = true;
          controller.inspect(state.file);
          assert.equal(state.timingError, true);
          assert.equal(state.timingWorker, null);
          WorkerDouble[fault] = false;
          controller.inspect(state.file);
          assert.ok(state.timingWorker);
        } finally { controller.dispose(); }
        assert.equal(state.timingWorker, null);
      });
  }
});
