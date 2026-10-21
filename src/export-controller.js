import { $ } from "./dom.js";
import { videoTimeAt } from "./data.js";
import { bindText } from "./i18n.js";
import { message, errorMessage } from "./messages.js";
export function createExportController(editor) {
  const { state, video } = editor;
  const dialog = $("export-dialog"),
    buttons = [...document.querySelectorAll("[data-save-video]")],
    listeners = new AbortController();
  let disposed = false,
    active = null;
  // Each callback belongs to one export. A canceled worker cannot finish a later job.
  function finishExport(session = active) {
    if (!session || session !== active) return false;
    active = null;
    const worker = session.worker;
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
    }
    if (state.worker === worker) state.worker = null;
    state.exporting = false;
    clearInterval(session.timer);
    if (dialog.open) dialog.close();
    if (!disposed) editor.refresh();
    return true;
  }
  function cancelExport() {
    if (!finishExport()) return;
    editor.notice(
      "Export canceled. Your source files and edits are unchanged.",
    );
  }
  $("cancel-export").onclick = cancelExport;
  dialog.addEventListener(
    "cancel",
    (event) => {
      event.preventDefault();
      cancelExport();
    },
    { signal: listeners.signal },
  );
  function startExport() {
    const theory = editor.theory?.forMeasurement(state.measurement) ?? null;
    if (
      disposed ||
      !state.file ||
      !state.data ||
      state.exporting ||
      state.loading ||
      state.csvLoading ||
      state.timingWorker ||
      state.theory?.loading ||
      (state.theory?.enabled &&
        state.theory?.file &&
        (!state.theory.valid || !theory))
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
      videoTimeAt(state.data.overallStart, state.offset, state.timeScale) <
        state.end;
    if (!overlaps) {
      editor.notice(
        "The CSV is outside the selected video range. Adjust its offset or the trim range before exporting.",
        "error",
      );
      return;
    }
    const sourceFile = state.file;
    const session = { worker: null, timer: undefined };
    active = session;
    try {
      video.pause();
      state.exporting = true;
      editor.refresh();
      bindText("export-status", "Preparing the encoder…");
      bindText("export-elapsed", "{seconds} s elapsed", { seconds: 0 });
      $("export-progress").value = 0;
      $("export-percent").textContent = "0%";
      dialog.showModal();
      const started = performance.now();
      session.timer = setInterval(() => {
        bindText("export-elapsed", "{seconds} s elapsed", {
          seconds: Math.floor((performance.now() - started) / 1000),
        });
      }, 1000);
      const format = $("export-format").value;
      const worker = new Worker(new URL("./export-worker.js", import.meta.url), {
        type: "module",
      });
      session.worker = state.worker = worker;
      worker.onmessage = ({ data }) => {
        if (active !== session || disposed) return;
        try {
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
            const nextURL = URL.createObjectURL(blob);
            if (state.exportURL) URL.revokeObjectURL(state.exportURL);
            state.exportURL = nextURL;
            const link = $("download-again");
            link.href = state.exportURL;
            link.download = `${sourceFile.name.replace(/\.[^.]+$/, "")}-flamesync.${format}`;
            link.hidden = false;
            link.click();
            finishExport(session);
            editor.notice(
              message(
                "Video saved · {size} MB. Download it again from Save your video below the editor.",
                { size: (blob.size / 1024 / 1024).toFixed(1) },
              ),
            );
          } else if (data.type === "error") {
            finishExport(session);
            editor.notice(data.error, "error");
          }
        } catch (error) {
          finishExport(session);
          editor.notice(errorMessage(error), "error");
        }
      };
      worker.onerror = (event) => {
        if (active !== session || disposed) return;
        event.preventDefault();
        finishExport(session);
        editor.notice(
          event.message
            ? message("Video creation stopped. {details}", {
                details: event.message,
              })
            : "Try a lower resolution or another format.",
          "error",
        );
      };
      worker.onmessageerror = () => {
        if (active !== session || disposed) return;
        finishExport(session);
        editor.notice(
          errorMessage(new Error("The encoded video response could not be read.")),
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
    } catch (error) {
      finishExport(session);
      editor.notice(errorMessage(error), "error");
    }
  }
  for (const button of buttons) button.onclick = startExport;

  return {
    dispose() {
      disposed = true;
      finishExport();
      listeners.abort();
      if ($("cancel-export").onclick === cancelExport)
        $("cancel-export").onclick = null;
      for (const button of buttons)
        if (button.onclick === startExport) button.onclick = null;
    },
  };
}
