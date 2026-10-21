import { message, errorMessage, UserError } from "./messages.js";
import { bindText } from "./i18n.js";
import { $ } from "./dom.js";
import { formatTime } from "./data.js";
import { demoCSV, createDemo } from "./demo.js";
import { downloadBlob } from "./files.js";
import { DEFAULT_CSV_SETTINGS } from "./units.js";
import { DEFAULT_VIDEO_FRAMING } from "./video-framing.js";
import { configureCSV } from "./csv-mapping.js";
import { csvClockIdentity, csvEventIdentity } from "./csv-import-policy.js";
import { createWorkerClient } from "./worker-client.js";
import { readVideoMetadata } from "./video-metadata.js";
export function createSourceController(editor) {
  const { state, video } = editor;
  let videoVersion = 0,
    csvVersion = 0,
    csvConfiguration = null,
    videoConfiguration = null,
    csvCandidate = null,
    forceNextCSV = false;
  const csvWorker = createWorkerClient(() => new Worker(new URL("./csv-worker.js", import.meta.url), { type: "module" }));
  const readSettings = () => ({
    ...state.csvSettings,
    timeUnit: $("csv-time-unit").value,
    thrustUnit: $("source-thrust-unit").value,
    pressureUnit: $("source-pressure-unit").value,
  });
  async function loadCSV(
    file,
    { settings = editor.preferences.csvImportSettings(), rememberSettings = false,
      configure = true, force = false } = {},
  ) {
    const version = ++csvVersion;
    csvConfiguration?.abort();
    const configuration = new AbortController();
    csvConfiguration = configuration;
    csvCandidate = file;
    csvWorker.reset();
    state.csvLoading = true;
    $("csv-columns").disabled = true;
    editor.refresh();
    try {
      if (file.size > 50 * 1024 * 1024)
        throw new UserError(
          "This CSV exceeds 50 MB. Export a smaller telemetry log first.",
        );
      if (configure) {
        settings = await configureCSV(file, settings, { force, signal: configuration.signal });
        if (version !== csvVersion) return;
        if (!settings) { csvCandidate = state.csvFile; return; }
      }
      if (version !== csvVersion) return;
      const sameFile = file === state.csvFile;
      const resetClock = !sameFile || csvClockIdentity(settings) !== csvClockIdentity(state.csvSettings);
      const resetEvents = resetClock || csvEventIdentity(settings) !== csvEventIdentity(state.csvSettings);
      const preserveSync = sameFile && !resetClock;
      const { data: parsed, reduced } = await csvWorker.request({ file, settings });
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
      }
      if (resetEvents) {
        editor.timeline.clearFeedback();
        editor.timeline.resetAnchors();
        editor.measurements.detect();
      }
      if (!preserveSync || resetEvents) editor.edits.reset();
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
      if (!preserveSync || resetEvents) editor.timeline.populateEvents();
      editor.notice(parsed.warnings, "warning");
    } catch (error) {
      if (version === csvVersion) {
        if (state.csvFile) csvCandidate = state.csvFile;
        editor.notice(errorMessage(error), "error");
      }
    } finally {
      if (version === csvVersion) {
        csvConfiguration = null;
        csvWorker.reset();
        state.csvLoading = false;
        $("csv-columns").disabled = false;
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
          configure: false,
        });
      else {
        state.csvSettings = settings;
        editor.preferences.saveCSVSettings(settings);
      }
    };
  }
  $("csv-columns").onclick = () => {
    if (state.csvLoading || state.exporting) return;
    if (state.csvFile) loadCSV(state.csvFile, { settings: state.csvSettings, force: true });
    else { forceNextCSV = true; $("csv-input").click(); }
  };
  $("csv-input").addEventListener("cancel", () => { forceNextCSV = false; });

  async function loadVideo(file) {
    const version = ++videoVersion;
    videoConfiguration?.abort();
    const configuration = new AbortController();
    videoConfiguration = configuration;
    const url = URL.createObjectURL(file);
    try {
      const metadata = await readVideoMetadata(url, { signal: configuration.signal });
      if (version !== videoVersion) {
        return;
      }
      editor.timeline.cancelDrag();
      video.pause();
      if (state.videoURL) URL.revokeObjectURL(state.videoURL);
      state.videoURL = url;
      const replacingVideo = Boolean(state.file);
      state.file = file;
      if (replacingVideo) Object.assign(state.style, DEFAULT_VIDEO_FRAMING);
      state.duration = metadata.duration;
      state.start = 0;
      state.end = metadata.duration;
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
      state.width = metadata.width;
      state.height = metadata.height;
      state.presentedTime = null;
      state.seekTime = null;
      editor.refresh();
      video.src = url;
      video.load();
      $("video-filename").textContent = file.name;
      bindText(
        $("video-meta"),
        message("{value0} × {value1} · {value2}", {
          value0: metadata.width,
          value1: metadata.height,
          value2: formatTime(metadata.duration, false),
        }),
      );
      $("video-drop").classList.add("loaded");
      $("video-track-name").textContent = file.name;
      bindText(
        $("preview-info"),
        message("{value0} × {value1}", {
          value0: metadata.width,
          value1: metadata.height,
        }),
      );
      $("total-time").textContent = formatTime(metadata.duration);
      editor.timeline.populateEvents();
      editor.timeline.resetView();
      editor.edits.reset();
      editor.refresh();
      editor.timeline.populateEvents();
      editor.player.updatePlayhead(0);
      editor.notice("");
      editor.videoInfo.inspect(file);
    } catch (error) {
      if (version === videoVersion) editor.notice(errorMessage(error), "error");
    } finally {
      if (state.videoURL !== url) URL.revokeObjectURL(url);
      if (videoConfiguration === configuration) videoConfiguration = null;
    }
  }

  for (const [kind, loader] of [
    ["video", loadVideo],
    ["csv", loadCSV],
  ]) {
    $(`${kind}-input`).addEventListener("change", (event) => {
      const file = event.target.files[0];
      const force = kind === "csv" && forceNextCSV;
      if (kind === "csv") forceNextCSV = false;
      if (file) {
        if (kind === "csv") loadCSV(file, { force });
        else loader(file);
      }
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
      videoConfiguration?.abort();
      csvVersion++;
      csvConfiguration?.abort();
      csvWorker.dispose();
    },
  };
}
