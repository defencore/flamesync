import { $ } from "./dom.js";
import { videoTimeAt } from "./data.js";
import { bindText } from "./i18n.js";
import { message } from "./messages.js";
export function createExportController(editor) {
  const { state, video } = editor;
  let exportTimer;
  function finishExport() {
    state.worker?.terminate();
    state.worker = null;
    state.exporting = false;
    clearInterval(exportTimer);
    $("export-dialog").close();
    editor.refresh();
  }
  $("cancel-export").onclick = () => {
    finishExport();
    editor.notice(
      "Export canceled. Your source files and edits are unchanged.",
    );
  };
  $("export-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    $("cancel-export").click();
  });
  function startExport() {
    const theory = editor.theory?.forMeasurement(state.measurement) ?? null;
    if (
      !state.file ||
      !state.data ||
      state.exporting ||
      state.loading ||
      state.csvLoading || state.theory?.loading ||
      (state.theory?.enabled && state.theory?.file && (!state.theory.valid || !theory))
    )
      return;
    if (
      typeof VideoEncoder === "undefined" ||
      typeof OffscreenCanvas === "undefined"
    ) {
      editor.notice(
        "Export requires WebCodecs and OffscreenCanvas. Use a recent Chrome, Edge, or Safari browser.",
        "error",
      );
      return;
    }
    const overlaps =
      videoTimeAt(state.data.overallEnd, state.offset, state.timeScale) >
        state.start &&
      videoTimeAt(state.data.overallStart, state.offset, state.timeScale) < state.end;
    if (!overlaps) {
      editor.notice(
        "The CSV is outside the selected video range. Adjust its offset or the trim range before exporting.",
        "error",
      );
      return;
    }
    const sourceFile = state.file;
    video.pause();
    state.exporting = true;
    editor.refresh();
    bindText("export-status", "Preparing the encoder…");
    $("export-progress").value = 0;
    $("export-percent").textContent = "0%";
    $("export-dialog").showModal();
    const started = performance.now();
    exportTimer = setInterval(() => {
      bindText("export-elapsed", "{seconds} s elapsed", {
        seconds: Math.floor((performance.now() - started) / 1000),
      });
    }, 1000);
    const format = $("export-format").value;
    const worker = new Worker(new URL("./export-worker.js", import.meta.url), {
      type: "module",
    });
    state.worker = worker;
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        $("export-progress").value = data.progress;
        $("export-percent").textContent =
          `${Math.min(99, Math.round(data.progress * 100))}%`;
        bindText(
          "export-status",
          data.progress >= 0.99
            ? "Finalizing your video…"
            : "Compositing and encoding frames…",
        );
      } else if (data.type === "done") {
        const blob = new Blob([data.buffer], {
          type: format === "mp4" ? "video/mp4" : "video/webm",
        });
        if (state.exportURL) URL.revokeObjectURL(state.exportURL);
        state.exportURL = URL.createObjectURL(blob);
        const link = $("download-again");
        link.href = state.exportURL;
        link.download = `${sourceFile.name.replace(/\.[^.]+$/, "")}-flamesync.${format}`;
        link.hidden = false;
        link.click();
        finishExport();
        editor.notice(
          message(
            "Video saved · {size} MB. Download it again from Save your video below the editor.",
            { size: (blob.size / 1024 / 1024).toFixed(1) },
          ),
        );
      } else if (data.type === "error") {
        finishExport();
        editor.notice(data.error, "error");
      }
    };
    worker.onerror = (event) => {
      finishExport();
      editor.notice(
        event.message
          ? message("Video creation stopped. {details}", {
              details: event.message,
            })
          : "Try a lower resolution or another format.",
        "error",
      );
    };
    worker.postMessage({
      file: state.file,
      data: state.data,
      style: { ...state.style },
      metadata: { ...state.metadata },
      sourceInfo: {
        ...editor.videoInfo.source(),
        videoName: sourceFile.name,
        logName: state.csvFile?.name ?? "",
      },
      measurement: editor.measurements.composition(),
      theory,
      offset: state.offset,
      timeScale: state.timeScale,
      start: state.start,
      end: state.end,
      format,
      quality: $("export-quality").value,
      maxEdge: Number($("export-resolution").value),
      fps: Number($("export-fps").value),
      keepAudio: $("keep-audio").checked,
    });
  }
  for (const button of document.querySelectorAll("[data-save-video]"))
    button.onclick = startExport;

  return {
    dispose() {
      state.worker?.terminate();
      clearInterval(exportTimer);
    },
  };
}
