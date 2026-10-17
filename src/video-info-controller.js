import { $, setText } from "./dom.js";
import { frameInfoAt, selectedFrameRange } from "./timing.js";
import { dataTimeAt, logPositionAt } from "./data.js";
import { sourceTimestamp } from "./units.js";
import { bindText } from "./i18n.js";
import { message, errorMessage } from "./messages.js";

export function createVideoInfoController(editor) {
  const { state, video } = editor;
  let sourceCache = null,
    sourceKey = null,
    timingKey = null,
    lastFrame = -1;
  function source() {
    if (!state.file) return null;
    if (sourceKey !== state.file || timingKey !== state.timing) {
      sourceKey = state.file;
      timingKey = state.timing;
      sourceCache = {
        width: state.width,
        height: state.height,
        fps: state.fps,
        timestamps: state.frameTimes,
        end: state.timing?.end ?? state.duration,
      };
    }
    return sourceCache;
  }
  function updateFrame(time) {
    const csvTime = dataTimeAt(time, state.offset, state.timeScale);
    const log = logPositionAt(state.data, csvTime);
    const percentage =
      log &&
      (log.fraction > 0.9995
        ? ">99.9%"
        : log.fraction < 0.0005
          ? "<0.1%"
          : `${(log.fraction * 100).toFixed(1)}%`);
    setText(
      "video-log-row",
      log?.first
        ? `${log.first.line}${log.second ? ` → ${log.second.line}` : ""}`
        : "—",
    );
    bindText(
      "video-log-status",
      !log
        ? "No CSV loaded"
        : log.phase === "exact"
          ? "Exact sample"
          : log.phase === "interpolated"
            ? message("Interpolated · {percentage}", { percentage })
            : log.phase === "gap"
              ? "Data gap · no interpolation"
              : log.phase === "before"
                ? "Before log"
                : "After log",
    );
    setText(
      "video-log-time",
      state.data ? sourceTimestamp(csvTime, state.data.sourceUnits.time) : "—",
    );
    const frame = frameInfoAt(
      state.frameTimes,
      time,
      state.timing?.end ?? state.duration,
    );
    if (!frame) {
      setText("video-frame-number", "—");
      bindText("video-frame-time", "—");
      bindText("video-frame-interval", "—");
      $("frame-progress").value = 0;
      $("frame-progress").max = 1;
      lastFrame = -1;
      return;
    }
    if (frame.index === lastFrame) return;
    lastFrame = frame.index;
    setText("video-frame-number", String(frame.number).padStart(6, "0"));
    bindText("video-frame-time", "{value} s", {
      value: frame.timestamp.toFixed(6),
    });
    bindText("video-frame-interval", "{value} ms", {
      value: (frame.duration * 1000).toFixed(3),
    });
    $("frame-progress").max = state.frameTimes.length;
    $("frame-progress").value = frame.number;
  }
  function updateSource() {
    $("video-inspector").hidden = !state.file;
    $("preview-workspace").classList.toggle("has-video", Boolean(state.file));
    const rate = state.timing
      ? message("{fps} fps{variable}", {
          fps: state.fps.toFixed(2).replace(/\.00$/, ""),
          variable: state.timing.variable ? " · VFR" : "",
        })
      : state.timingError
        ? "Unavailable"
        : state.file
          ? "Checking…"
          : "—";
    const logRate = state.data
      ? `${((state.data.points.length - 1) / state.data.duration).toFixed(1)} Hz`
      : "—";
    bindText("timing-video-rate", rate);
    setText("timing-log-rate", logRate);
    bindText(
      "timing-log-detail",
      state.data
        ? message("{count} samples · {duration} s · average CSV rate", {
            count: state.data.points.length.toLocaleString("en-US"),
            duration: state.data.duration.toFixed(3),
          })
        : "",
    );
    bindText(
      "source-fps-option",
      state.timing
        ? message("Match source · {fps} fps{variable}", {
            fps: state.fps.toFixed(2).replace(/\.00$/, ""),
            variable: state.timing.variable ? " · VFR" : "",
          })
        : "Match source · original timestamps",
    );
    setText(
      "video-frame-count",
      state.frameTimes.length
        ? state.frameTimes.length.toLocaleString("en-US")
        : "—",
    );
    setText("video-resolution", `${state.width} × ${state.height}`);
    setText("video-source-name", state.file?.name ?? "—");
    bindText(
      "video-file-size",
      state.file
        ? message("{value} MB", {
            value: (state.file.size / 1024 / 1024).toFixed(1),
          })
        : "—",
    );
    setText("video-codec", state.timing?.codec ?? "—");
    bindText("video-source-duration", "{value} s", {
      value: (state.timing?.end ?? state.duration).toFixed(6),
    });
    updateSelection();
    updateFrame(state.presentedTime ?? video.currentTime);
  }
  function updateSelection() {
    const range = selectedFrameRange(
      state.frameTimes,
      state.start,
      state.end,
      state.timing?.end ?? state.duration,
    );
    bindText(
      "video-selected-frames",
      range
        ? message(
            range.count === 1
              ? "{first}–{last} · {count} frame"
              : "{first}–{last} · {count} frames",
            { first: range.first, last: range.last, count: range.count },
          )
        : "—",
    );
  }
  function inspect(file) {
    state.timingWorker?.terminate();
    lastFrame = -1;
    const worker = new Worker(
      new URL("./video-timing-worker.js", import.meta.url),
      { type: "module" },
    );
    state.timingWorker = worker;
    const finish = () => {
      worker.terminate();
      if (state.timingWorker === worker) state.timingWorker = null;
    };
    const failed = (error) => {
      if (state.file !== file) return;
      state.timingError = true;
      bindText("timing-video-detail", [
        message("Frame inspection unavailable."),
        error,
      ]);
      bindText("preview-info", "{width} × {height} · FPS unavailable", {
        width: state.width,
        height: state.height,
      });
      finish();
      editor.refresh();
    };
    worker.onmessage = ({ data }) => {
      if (state.file !== file) return;
      if (data.type === "progress")
        bindText("timing-video-detail", "Checking {count} frames…", {
          count: data.frames.toLocaleString("en-US"),
        });
      else if (data.type === "error") failed(data.error);
      else if (data.type === "done") {
        state.timing = data.timing;
        state.fps = data.timing.fps;
        state.frameTimes = new Float64Array(data.timestamps);
        lastFrame = -1;
        bindText("preview-info", "{width} × {height} · {fps} fps{variable}", {
          width: state.width,
          height: state.height,
          fps: state.fps.toFixed(2),
          variable: data.timing.variable ? " · VFR" : "",
        });
        bindText(
          "timing-video-detail",
          data.timing.variable
            ? "{count} frames checked · {duration} s · variable rate"
            : "{count} frames checked · {duration} s · constant rate",
          {
            count: data.timing.frameCount.toLocaleString("en-US"),
            duration: data.timing.end.toFixed(3),
          },
        );
        finish();
        editor.refresh();
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      failed(errorMessage(new Error(event.message || "Unsupported container")));
    };
    worker.postMessage({ file });
  }
  return {
    source,
    updateSource,
    updateSelection,
    updateFrame,
    inspect,
    dispose() {
      state.timingWorker?.terminate();
    },
  };
}
