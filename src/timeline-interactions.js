import { $ } from "./dom.js";
import { clamp, videoTimeAt, MIN_TIME_SCALE, MAX_TIME_SCALE } from "./data.js";
import { stepTrimBoundary } from "./edit-model.js";

// Captured pointers are reversible transactions, including cancellation or Escape.
export function bindTimelineInteractions(editor, view, sync, setTrim) {
  const { state, video } = editor;
  const listeners = new AbortController();
  let active = null,
    cancelScrub = null;
  function drag(element, begin, move) {
    element.addEventListener(
      "pointerdown",
      (event) => {
        if (!state.file || event.button !== 0 || active) return;
        const snapshot = begin();
        if (snapshot === null) return;
        event.preventDefault();
        event.stopPropagation();
        video.pause();
        const source = state.file,
          pointerId = event.pointerId;
        const startX = event.clientX;
        const span = view.viewport().end - view.viewport().start;
        const width = $("tracks-body").getBoundingClientRect().width;
        editor.edits.begin();
        element.setPointerCapture(pointerId);
        element.classList.add("dragging");
        const events = new AbortController();
        let frame = 0,
          pending = null;
        function flush() {
          frame = 0;
          if (!pending || state.file !== source) return;
          const pointer = pending;
          pending = null;
          move(
            ((pointer.clientX - startX) / width) * span,
            snapshot,
            pointer,
            width,
          );
        }
        function finish(cancel = false) {
          if (!active) return;
          cancelAnimationFrame(frame);
          if (!cancel) flush();
          events.abort();
          active = null;
          element.classList.remove("dragging");
          $("timeline-snap-line").hidden = true;
          if (element.hasPointerCapture(pointerId))
            element.releasePointerCapture(pointerId);
          if (cancel) {
            editor.edits.cancel();
            editor.player.seek(snapshot.playhead);
          } else editor.edits.commit();
        }
        active = { cancel: () => finish(true) };
        element.addEventListener(
          "pointermove",
          (e) => {
            if (e.pointerId !== pointerId) return;
            pending = { clientX: e.clientX, altKey: e.altKey };
            if (!frame) frame = requestAnimationFrame(flush);
          },
          { signal: events.signal },
        );
        element.addEventListener(
          "pointerup",
          (e) => {
            if (e.pointerId === pointerId) finish();
          },
          { signal: events.signal },
        );
        for (const kind of ["pointercancel", "lostpointercapture"])
          element.addEventListener(
            kind,
            (e) => {
              if (e.pointerId === pointerId) finish(true);
            },
            { signal: events.signal },
          );
        document.addEventListener(
          "keydown",
          (e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopImmediatePropagation();
              finish(true);
            }
          },
          { capture: true, signal: events.signal },
        );
      },
      { signal: listeners.signal },
    );
  }
  const selection = () => ({
    offset: state.offset,
    scale: state.timeScale,
    start: state.start,
    end: state.end,
    playhead: editor.player.currentTime(),
  });
  function snappedOffset(offset, event, width) {
    $("timeline-snap-line").hidden = true;
    if (!state.snapping || event.altKey) return offset;
    const tolerance =
      ((view.viewport().end - view.viewport().start) / width) * 8;
    const targets = [
      editor.player.currentTime(),
      state.start,
      state.end,
      0,
      state.duration,
    ];
    let best = tolerance,
      result = offset,
      targetTime = null;
    for (const anchor of [state.data.start, state.csvAnchor, state.data.end])
      for (const target of targets) {
        const delta = target - videoTimeAt(anchor, offset, state.timeScale);
        if (Math.abs(delta) < best) {
          best = Math.abs(delta);
          result = offset + delta;
          targetTime = target;
        }
      }
    if (targetTime !== null) {
      const position =
        ((targetTime - view.viewport().start) /
          (view.viewport().end - view.viewport().start)) *
        100;
      $("timeline-snap-line").style.left = `${position}%`;
      $("timeline-snap-line").hidden = position < 0 || position > 100;
    }
    return result;
  }
  drag(
    $("csv-track"),
    () => (state.data ? selection() : null),
    (delta, snapshot, event, width) =>
      sync.setOffset(snappedOffset(snapshot.offset + delta, event, width)),
  );
  drag(
    $("stretch-handle"),
    () => (state.data ? selection() : null),
    (delta, snapshot) =>
      sync.setTimeScale(
        clamp(
          snapshot.scale + delta / state.data.duration,
          MIN_TIME_SCALE,
          MAX_TIME_SCALE,
        ),
        state.data.start,
      ),
  );
  for (const edge of ["start", "end"]) {
    const handle = $(`trim-handle-${edge}`);
    drag(handle, selection, (delta, snapshot, event) =>
      setTrim(edge, snapshot[edge] + delta, true, {
        snap: state.snapping && !event.altKey,
      }),
    );
    handle.addEventListener(
      "keydown",
      (event) => {
        if (
          !state.file ||
          !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const time =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? state.duration
              : stepTrimBoundary(
                  state[edge],
                  event.key === "ArrowLeft" ? -1 : 1,
                  state.frameTimes,
                  state.duration,
                );
        setTrim(edge, time, true, { snap: true });
      },
      { signal: listeners.signal },
    );
  }
  $("csv-track").addEventListener(
    "keydown",
    (event) => {
      if (
        !state.file ||
        !state.data ||
        !["ArrowLeft", "ArrowRight"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      sync.setOffset(
        state.offset +
          (event.key === "ArrowLeft" ? -1 : 1) *
            (event.shiftKey ? 0.001 : 0.01),
      );
    },
    { signal: listeners.signal },
  );
  $("stretch-handle").addEventListener(
    "keydown",
    (event) => {
      if (
        !state.file ||
        !state.data ||
        !["ArrowLeft", "ArrowRight"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      sync.setTimeScale(
        clamp(
          state.timeScale + (event.key === "ArrowLeft" ? -0.01 : 0.01),
          MIN_TIME_SCALE,
          MAX_TIME_SCALE,
        ),
        state.data.start,
      );
    },
    { signal: listeners.signal },
  );
  for (const element of [$("video-track"), $("timeline-ticks")]) {
    element.addEventListener(
      "pointerdown",
      (event) => {
        if (
          !state.file ||
          event.button !== 0 ||
          event.target.closest(".trim-handle")
        )
          return;
        cancelScrub?.();
        event.preventDefault();
        video.pause();
        const source = state.file;
        const events = new AbortController();
        const done = () => {
          events.abort();
          cancelScrub = null;
          if (element.hasPointerCapture(event.pointerId))
            element.releasePointerCapture(event.pointerId);
        };
        cancelScrub = done;
        element.setPointerCapture(event.pointerId);
        const seek = (x) => {
          if (state.file === source)
            editor.player.seek(clamp(view.pointerTime(x), 0, state.duration));
        };
        seek(event.clientX);
        element.addEventListener(
          "pointermove",
          (e) => {
            if (e.pointerId === event.pointerId) seek(e.clientX);
          },
          { signal: events.signal },
        );
        for (const kind of ["pointerup", "pointercancel", "lostpointercapture"])
          element.addEventListener(
            kind,
            (e) => {
              if (e.pointerId === event.pointerId) done();
            },
            { signal: events.signal },
          );
      },
      { signal: listeners.signal },
    );
  }
  $("tracks-body").addEventListener(
    "wheel",
    (event) => {
      if (
        !state.file ||
        !(
          event.altKey ||
          event.shiftKey ||
          Math.abs(event.deltaX) > Math.abs(event.deltaY)
        )
      )
        return;
      event.preventDefault();
      if (event.altKey)
        view.zoom(
          Math.exp(-event.deltaY * 0.005),
          view.pointerTime(event.clientX),
        );
      else
        view.pan(
          ((event.deltaX || event.deltaY) / $("tracks-body").clientWidth) *
            (view.viewport().end - view.viewport().start),
        );
    },
    { passive: false, signal: listeners.signal },
  );
  return {
    cancel() {
      active?.cancel();
      cancelScrub?.();
    },
    dispose() {
      active?.cancel();
      cancelScrub?.();
      listeners.abort();
    },
  };
}
