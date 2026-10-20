import { message, errorMessage, UserError } from "./messages.js";
import { bindText } from "./i18n.js";
import { $ } from "./dom.js";
import { formatTime } from "./data.js";
import { demoCSV, createDemo } from "./demo.js";
import { downloadBlob } from "./files.js";
import { DEFAULT_CSV_SETTINGS } from "./units.js";
import { DEFAULT_VIDEO_FRAMING } from "./video-framing.js";
export function createSourceController(editor) {
  const { state, video } = editor;
  let videoVersion = 0,
    csvVersion = 0,
    csvTask = null,
    csvCandidate = null;
  const readSettings = () => ({
    timeUnit: $("csv-time-unit").value,
    thrustUnit: $("source-thrust-unit").value,
    pressureUnit: $("source-pressure-unit").value,
  });
  function readCSV(file, settings) {
    const worker = new Worker(new URL("./csv-worker.js", import.meta.url), {
      type: "module",
    });
    let rejectRead;
    const promise = new Promise((resolve, reject) => {
      rejectRead = reject;
      worker.onmessage = ({ data }) => {
        worker.terminate();
        if (data.type === "done") resolve(data);
        else reject(new UserError(data.error.key, data.error.values));
      };
      worker.onerror = (event) => {
        event.preventDefault();
        worker.terminate();
        reject(
          new UserError("The CSV could not be read. {details}", {
            details: event.message || "",
          }),
        );
      };
      worker.postMessage({ file, settings });
    });
    return {
      promise,
      cancel() {
        worker.terminate();
        rejectRead(new DOMException("CSV read canceled.", "AbortError"));
      },
    };
  }
  async function loadCSV(
    file,
    { preserveSync = false, settings = editor.preferences.csvImportSettings(), rememberSettings = false } = {},
  ) {
    const version = ++csvVersion;
    csvCandidate = file;
    csvTask?.cancel();
    state.csvLoading = true;
    editor.refresh();
    let task;
    try {
      if (file.size > 50 * 1024 * 1024)
        throw new UserError(
          "This CSV exceeds 50 MB. Export a smaller telemetry log first.",
        );
      task = readCSV(file, { ...settings });
      csvTask = task;
      const { data: parsed, reduced } = await task.promise;
      if (version !== csvVersion) return;
      editor.timeline.cancelDrag();
      state.data = parsed;
      state.csvFile = file;
      state.csvSettings = { ...settings };
      if (rememberSettings) editor.preferences.saveCSVSettings(settings);
      state.reduced = reduced;
      if (!preserveSync) {
        state.timeScale = 1;
        state.offset = 0;
        editor.timeline.clearFeedback();
        editor.timeline.resetAnchors();
        editor.edits.reset();
        editor.measurements.detect();
      }
      $("csv-end-anchor").min = String(parsed.start);
      $("csv-end-anchor").max = String(parsed.end);
      $("csv-filename").textContent = file.name;
      bindText(
        $("csv-meta"),
        message("{value0} samples · {value1} s", {
          value0: parsed.points.length.toLocaleString("en-US"),
          value1: parsed.duration.toFixed(3),
        }),
      );
      $("csv-drop").classList.add("loaded");
      $("csv-track-name").textContent = file.name;
      editor.refresh();
      if (!preserveSync) editor.timeline.populateEvents();
      editor.notice(parsed.warnings, "warning");
    } catch (error) {
      if (version === csvVersion) editor.notice(errorMessage(error), "error");
    } finally {
      if (csvTask === task) csvTask = null;
      if (version === csvVersion) {
        state.csvLoading = false;
        for (const [id, key] of [
          ["csv-time-unit", "timeUnit"],
          ["source-thrust-unit", "thrustUnit"],
          ["source-pressure-unit", "pressureUnit"],
        ])
          $(id).value = state.csvSettings[key];
        editor.refresh();
      }
    }
  }

  for (const id of [
    "csv-time-unit",
    "source-thrust-unit",
    "source-pressure-unit",
  ]) {
    $(id).onchange = () => {
      const settings = readSettings();
      if (csvCandidate)
        loadCSV(csvCandidate, {
          settings,
          rememberSettings: true,
          preserveSync:
            csvCandidate === state.csvFile &&
            settings.timeUnit === state.csvSettings.timeUnit,
        });
      else {
        state.csvSettings = settings;
        editor.preferences.saveCSVSettings(settings);
      }
    };
  }

  async function loadVideo(file) {
    const version = ++videoVersion;
    const url = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new UserError(
                "The video metadata could not be read. Try an MP4 or WebM file supported by your browser.",
              ),
            ),
          20000,
        );
        probe.onloadedmetadata = () => {
          clearTimeout(timer);
          resolve();
        };
        probe.onerror = () => {
          clearTimeout(timer);
          reject(
            new UserError(
              "This browser cannot play this video. Try an H.264 MP4 or VP9 WebM file.",
            ),
          );
        };
        probe.src = url;
      });
      if (version !== videoVersion) {
        URL.revokeObjectURL(url);
        return;
      }
      if (
        !Number.isFinite(probe.duration) ||
        probe.duration <= 0.001 ||
        !probe.videoWidth ||
        !probe.videoHeight
      ) {
        throw new UserError(
          "The video needs a finite duration and a playable video track.",
        );
      }
      editor.timeline.cancelDrag();
      video.pause();
      if (state.videoURL) URL.revokeObjectURL(state.videoURL);
      state.videoURL = url;
      const replacingVideo = Boolean(state.file);
      state.file = file;
      if (replacingVideo) Object.assign(state.style, DEFAULT_VIDEO_FRAMING);
      state.duration = probe.duration;
      state.start = 0;
      state.end = probe.duration;
      state.offset = 0;
      state.timeScale = 1;
      editor.timeline.clearFeedback();
      state.fps = 0;
      state.timing = null;
      state.timingError = false;
      state.frameTimes = new Float64Array();
      bindText(
        $("timing-video-detail"),
        message("Checking all frame timestamps…"),
      );
      state.width = probe.videoWidth;
      state.height = probe.videoHeight;
      state.presentedTime = null;
      state.seekTime = null;
      editor.refresh();
      video.src = url;
      video.load();
      $("video-filename").textContent = file.name;
      bindText(
        $("video-meta"),
        message("{value0} × {value1} · {value2}", {
          value0: probe.videoWidth,
          value1: probe.videoHeight,
          value2: formatTime(probe.duration, false),
        }),
      );
      $("video-drop").classList.add("loaded");
      $("video-track-name").textContent = file.name;
      bindText(
        $("preview-info"),
        message("{value0} × {value1}", {
          value0: probe.videoWidth,
          value1: probe.videoHeight,
        }),
      );
      $("total-time").textContent = formatTime(probe.duration);
      editor.timeline.populateEvents();
      editor.timeline.resetView();
      editor.edits.reset();
      editor.refresh();
      editor.timeline.populateEvents();
      editor.player.updatePlayhead(0);
      editor.notice("");
      editor.videoInfo.inspect(file);
    } catch (error) {
      if (state.videoURL !== url) URL.revokeObjectURL(url);
      editor.notice(errorMessage(error), "error");
    } finally {
      probe.removeAttribute("src");
      probe.load();
    }
  }

  for (const [kind, loader] of [
    ["video", loadVideo],
    ["csv", loadCSV],
  ]) {
    $(`${kind}-input`).addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file) loader(file);
      event.target.value = "";
    });
  }

  async function loadSources(files) {
    const list = [...files];
    const logs = list.filter((file) => /\.(csv|tsv|txt)$/i.test(file.name));
    const videos = list.filter(
      (file) =>
        file.type.startsWith("video/") ||
        /\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name),
    );
    if (
      logs.length > 1 ||
      videos.length > 1 ||
      logs.length + videos.length !== list.length
    ) {
      editor.notice(
        "Drop one video and one CSV log, together or separately.",
        "error",
      );
      return;
    }
    if (videos[0]) await loadVideo(videos[0]);
    if (logs[0]) await loadCSV(logs[0]);
  }
  let dragDepth = 0;
  const workspace = $("workspace");
  workspace.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepth++;
    workspace.classList.add("files-dragover");
  });
  workspace.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) workspace.classList.remove("files-dragover");
  });
  workspace.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    workspace.classList.remove("files-dragover");
    if (event.dataTransfer.files.length) loadSources(event.dataTransfer.files);
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());
  $("import-files").onclick = () => $("import-input").click();
  $("import-input").onchange = (event) => {
    if (event.target.files.length) loadSources(event.target.files);
    event.target.value = "";
  };
  $("preview-upload").onclick = () => $("video-input").click();

  $("sample-csv").onclick = () =>
    downloadBlob(
      new Blob([demoCSV()], { type: "text/csv;charset=utf-8" }),
      "flamesync-sample.csv",
    );
  $("demo-button").onclick = async () => {
    if (state.loading) return;
    state.loading = true;
    $("demo-button").disabled = true;
    const button = $("demo-button");
    bindText(button, message("Preparing demo…"));
    editor.refresh();
    try {
      const demo = await createDemo((progress) => {
        bindText(
          button,
          message("Preparing demo… {value0}%", {
            value0: Math.round(progress * 100),
          }),
        );
      });
      await loadVideo(demo.file);
      await loadCSV(
        new File([demo.csv], "static-fire-demo.csv", { type: "text/csv" }),
        {
          settings: { ...DEFAULT_CSV_SETTINGS },
        },
      );
      if (state.file === demo.file) {
        editor.timeline.setOffset(1);
        editor.player.seek(3.5);
      }
      editor.notice(
        "Demo loaded: synthetic footage, audio, and sample telemetry. Replace either source with your own files.",
      );
    } catch (error) {
      editor.notice(
        message("The demo could not be generated: {value0}", {
          value0: error.message,
        }),
        "error",
      );
    } finally {
      state.loading = false;
      button.disabled = false;
      bindText(button, "Load demo");
      editor.refresh();
    }
  };

  return {
    loadVideo,
    loadCSV,
    dispose() {
      videoVersion++;
      csvVersion++;
      csvTask?.cancel();
    },
  };
}
