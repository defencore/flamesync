import { $ } from "./dom.js";
import { bindText, bindAttribute } from "./i18n.js";
import { trimRange } from "./edit-model.js";
import { selectedFrameRange } from "./timing.js";
import { createSynchronizationController } from "./synchronization-controller.js";
import { createTimelineView } from "./timeline-view.js";
import { bindTimelineInteractions } from "./timeline-interactions.js";

export function createTimelineController(editor) {
  const { state, video } = editor;
  const sync = createSynchronizationController(editor);
  const view = createTimelineView(editor);
  function setTrim(edge, time, follow = false, { snap = false } = {}) {
    if (!state.file || !Number.isFinite(time)) return;
    const next = trimRange(
      state,
      edge,
      time,
      state.duration,
      snap ? state.frameTimes : [],
    );
    video.pause();
    editor.edits.change(next);
    if (follow) {
      // Out is exclusive: preview the final included frame, never the first removed one.
      const frames = selectedFrameRange(
        state.frameTimes,
        next.start,
        next.end,
        state.duration,
      );
      const target =
        edge === "start"
          ? next.start
          : frames
            ? state.frameTimes[frames.last - 1]
            : Math.max(next.start, next.end - 0.001);
      editor.player.seek(target);
    }
  }
  for (const edge of ["start", "end"])
    $(`trim-${edge}`).onchange = (event) =>
      setTrim(
        edge,
        event.target.value === "" ? state[edge] : Number(event.target.value),
        true,
      );
  $("clear-trim").onclick = () => {
    video.pause();
    editor.edits.change({ start: 0, end: state.duration });
  };
  $("reset-timeline").onclick = () => {
    video.pause();
    sync.clearFeedback();
    editor.edits.change({
      start: 0,
      end: state.duration,
      offset: 0,
      timeScale: 1,
      csvAnchor: state.data?.ignition ?? 0,
      csvEndAnchor: state.data?.end ?? 0,
    });
    sync.populateEvents();
    view.fit();
    editor.player.seek(0);
  };
  const gestures = bindTimelineInteractions(editor, view, sync, setTrim);
  return {
    update() {
      $("trim-start").value = state.start.toFixed(3);
      $("trim-end").value = state.end.toFixed(3);
      $("trim-start").max = String(Math.max(0, state.end - 0.001));
      $("trim-end").max = String(state.duration || 1);
      $("trim-end").min = String(state.start + 0.001);
      bindText("trim-duration", "{value0} s selected", {
        value0: Math.max(0, state.end - state.start).toFixed(3),
      });
      bindAttribute(
        "jump-start",
        "title",
        "Go to selected start: {time} s (Home)",
        { time: state.start.toFixed(3) },
      );
      sync.update();
      view.render();
      editor.edits.update();
    },
    setTrim,
    setOffset: sync.setOffset,
    setAnchors: sync.setAnchors,
    resetAnchors: sync.resetAnchors,
    clearFeedback: sync.clearFeedback,
    populateEvents: sync.populateEvents,
    alignIgnition: sync.alignIgnition,
    updatePlayhead: view.updatePlayhead,
    ensureVisible: view.ensureVisible,
    zoom: view.zoom,
    fit: view.fit,
    fitSelection: view.fitSelection,
    resetView: view.reset,
    cancelDrag: gestures.cancel,
    dispose() {
      gestures.dispose();
      view.dispose();
    },
  };
}
