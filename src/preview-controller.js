import { $ } from "./dom.js";
import { compositionSize } from "./data.js";
import { drawComposition, compositionGeometry } from "./composition.js";
export function createPreviewController(editor) {
  const { state, video, canvas } = editor;
  const ctx = canvas.getContext("2d", { alpha: false });
  function render(time = state.presentedTime ?? video.currentTime) {
    const w = canvas.width;
    const h = canvas.height;
    const ready = state.file && video.readyState >= 2;
    const sourceInfo = editor.videoInfo.source();
    drawComposition(
      ctx,
      w,
      h,
      ready
        ? (context, x, y, width, height) =>
            context.drawImage(video, x, y, width, height)
        : null,
      state.width,
      state.height,
      state.data,
      state.reduced,
      time,
      state.offset,
      state.timeScale,
      state.style,
      state.metadata,
      sourceInfo && {
        ...sourceInfo,
        videoName: state.file.name,
        logName: state.csvFile?.name ?? "",
      },
      editor.measurements.composition(),
      editor.theory?.forMeasurement(state.measurement),
    );
  }

  function updateComposition() {
    const size = compositionSize(
      state.width,
      state.height,
      1920,
      state.style.frameAspect,
    );
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
    }
    $("preview-stage").style.aspectRatio = `${size.width} / ${size.height}`;
    const geometry = compositionGeometry(
      size.width,
      size.height,
      state.width,
      state.height,
      state.style,
    );
    $("empty-state").style.right =
      `${((geometry.info?.width ?? 0) / size.width) * 100}%`;
    $("opacity-setting").hidden = state.style.layout === "full";
    $("details-layout-note").hidden = state.style.layout !== "overlay";
    const stacked = state.style.layout === "stacked";
    $("video-framing").hidden = !stacked;
    $("video-framing-drag").hidden = !stacked;
    $("theme-setting").hidden = stacked;
    $("height-setting").hidden = stacked;
    $("summary-setting").hidden = stacked;
    $("impulse-setting").hidden = stacked && state.style.showDetails;
    $("overlay-opacity").min = stacked ? "0" : "45";
    $("overlay-opacity").max = stacked ? "95" : "100";
    $("overlay-opacity").value = String(state.style.opacity);
    $("opacity-value").textContent = `${state.style.opacity}%`;
  }

  return { render, resize: updateComposition };
}
