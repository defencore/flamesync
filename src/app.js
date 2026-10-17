import { $ } from "./dom.js";
import { createEditController } from "./edit-controller.js";
import { bindEditorShortcuts } from "./shortcuts.js";
import { createEditorState } from "./state.js";
import { createPreviewController } from "./preview-controller.js";
import { createPlayerController } from "./player-controller.js";
import { createSourceController } from "./source-controller.js";
import { createTimelineController } from "./timeline-controller.js";
import { createMeasurementController } from "./measurement-controller.js";
import { createVideoInfoController } from "./video-info-controller.js";
import { createUIController } from "./ui-controller.js";
import { bindAppearanceControls } from "./appearance-controller.js";
import { createExportController } from "./export-controller.js";
import { bindTooltips } from "./tooltips.js";
import { initializeLanguage, bindText } from "./i18n.js";
import { errorMessage } from "./messages.js";

const state = createEditorState();
let refreshFrame = 0,
  fullRefresh = false,
  disposeShortcuts;
const editor = {
  state,
  video: $("source-video"),
  canvas: $("preview"),
  notice(message, kind = "success") {
    bindText("notice", message);
    $("notice").className = kind;
    $("notice").hidden =
      !message || (Array.isArray(message) && !message.length);
  },
  refresh(scope = "all") {
    fullRefresh ||= scope === "all";
    if (refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      const full = fullRefresh;
      fullRefresh = false;
      if (full) editor.preview.resize();
      editor.timeline.update();
      if (full) {
        editor.ui.update();
        editor.videoInfo.updateSource();
      } else {
        editor.ui.updateExport();
        editor.videoInfo.updateSelection();
      }
      editor.measurements.update();
      editor.player.updatePlayhead();
      editor.preview.render();
    });
  },
};

try {
  initializeLanguage();
  editor.ui = createUIController(editor);
  editor.preview = createPreviewController(editor);
  editor.videoInfo = createVideoInfoController(editor);
  editor.measurements = createMeasurementController(editor);
  editor.edits = createEditController(editor);
  editor.timeline = createTimelineController(editor);
  editor.player = createPlayerController(editor);
  disposeShortcuts = bindEditorShortcuts(editor);
  editor.sources = createSourceController(editor);
  editor.exports = createExportController(editor);
  bindAppearanceControls(editor);
  bindTooltips();
  editor.refresh();
  document.addEventListener("flamesync:language", () => editor.refresh());
} catch (error) {
  editor.notice(errorMessage(error), "error");
}

window.addEventListener("beforeunload", (event) => {
  if (state.exporting) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  cancelAnimationFrame(refreshFrame);
  disposeShortcuts?.();
  editor.player?.dispose();
  editor.timeline?.dispose();
  editor.videoInfo?.dispose();
  editor.exports?.dispose();
  editor.sources?.dispose();
  editor.measurements?.dispose();
  if (state.videoURL) URL.revokeObjectURL(state.videoURL);
  if (state.exportURL) URL.revokeObjectURL(state.exportURL);
});
