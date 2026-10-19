import { $ } from "./dom.js";
import { containRect } from "./data.js";
import { errorMessage } from "./messages.js";
import { compositionGeometry } from "./composition-layout.js";
import { DEFAULT_VIDEO_FRAMING, moveVideoFraming, videoFraming } from "./video-framing.js";

// Placement is visual only. It never edits source frames, trimming, or synchronization.
export function createVideoFramingController(editor) {
  const { state, canvas } = editor;
  const listeners = new AbortController();
  const stage = $("preview-stage");
  const dragButton = $("video-framing-drag");
  const controls = [
    ["video-position-x", "videoX", "video-position-x-value"],
    ["video-position-y", "videoY", "video-position-y-value"],
    ["video-scale", "videoScale", "video-scale-value"],
  ];
  let disposed = false, dragMode = false, active = null, animation = 0;
  canvas.tabIndex = 0;

  function listen(target, event, handler, options = {}) {
    target.addEventListener(event, handler, { ...options, signal: listeners.signal });
  }
  function available() {
    return !disposed && state.style.layout === "stacked" &&
      Boolean(state.file) && !state.loading && !state.exporting &&
      !$("video-editor").hidden;
  }
  function sameGeometry(gesture) {
    return state.file === gesture.source && state.width === gesture.sourceWidth &&
      state.height === gesture.sourceHeight && state.style.frameAspect === gesture.aspect &&
      canvas.width === gesture.canvasWidth && canvas.height === gesture.canvasHeight;
  }
  function setDragMode(enabled) {
    dragMode = Boolean(enabled && available());
    dragButton.setAttribute("aria-pressed", String(dragMode));
    stage.dataset.videoFraming = String(dragMode);
  }
  function paint() {
    update();
    editor.preview.render();
  }
  function apply(gesture) {
    if (!gesture.ready || !sameGeometry(gesture) || !available()) return;
    const placement = moveVideoFraming(
      gesture.initial,
      (gesture.clientX - gesture.startX) * gesture.outputPerClientPixel,
      (gesture.clientY - gesture.startY) * gesture.outputPerClientPixel,
      gesture.body,
    );
    Object.assign(state.style, placement);
    paint();
  }
  function flush() {
    animation = 0;
    if (active) apply(active);
  }
  function release(gesture) {
    gesture.released = true;
    canvas.classList.remove("dragging");
    if (canvas.hasPointerCapture(gesture.pointerId)) canvas.releasePointerCapture(gesture.pointerId);
  }
  function finish(cancel = false, render = true) {
    const gesture = active;
    if (!gesture) return;
    cancelAnimationFrame(animation);
    animation = 0;
    // A quick pointer release still commits its final position after decoding the selected frame.
    if (!cancel && !gesture.ready) {
      gesture.completed = true;
      release(gesture);
      return;
    }
    if (!cancel) apply(gesture);
    active = null;
    // A different source owns its own current placement and must not receive this draft.
    if (cancel && state.file === gesture.source) Object.assign(state.style, gesture.initial);
    release(gesture);
    if (render && !disposed) paint();
  }
  function update() {
    const enabled = available();
    if (active && (!enabled || !sameGeometry(active))) finish(true, false);
    if (!enabled) setDragMode(false);
    $("video-framing").hidden = state.style.layout !== "stacked";
    dragButton.hidden = state.style.layout !== "stacked";
    dragButton.disabled = !enabled;
    $("video-framing-reset").disabled = !enabled;
    const framing = videoFraming(state.style);
    for (const [id, key, output] of controls) {
      $(id).disabled = !enabled;
      $(id).value = String(framing[key]);
      const value = Math.round(framing[key] * 10) / 10;
      $(output).textContent = `${key !== "videoScale" && value > 0 ? "+" : ""}${value}%`;
    }
  }

  for (const [id, key] of controls) listen($(id), "input", (event) => {
    if (!available()) return;
    finish(true, false);
    Object.assign(state.style, videoFraming({ ...state.style, [key]: Number(event.target.value) }));
    paint();
  });
  listen($("video-framing-reset"), "click", () => {
    if (!available()) return;
    finish(true, false);
    Object.assign(state.style, DEFAULT_VIDEO_FRAMING);
    paint();
  });
  listen(dragButton, "click", () => {
    finish(true, false);
    setDragMode(!dragMode);
    if (dragMode) canvas.focus({ preventScroll: true });
    paint();
  });

  listen(canvas, "pointerdown", (event) => {
    if (!dragMode || !available() || event.button !== 0 || !event.isPrimary || active) return;
    const bounds = canvas.getBoundingClientRect();
    const visible = containRect(canvas.width, canvas.height,
      { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height });
    if (!visible.width || !visible.height) return;
    const body = compositionGeometry(canvas.width, canvas.height, state.width, state.height, state.style).videoFrame;
    const outputPerClientPixel = canvas.width / visible.width;
    const x = (event.clientX - visible.x) * outputPerClientPixel;
    const y = (event.clientY - visible.y) * outputPerClientPixel;
    if (!body || x < body.x || x > body.x + body.width || y < body.y || y > body.y + body.height) return;
    event.preventDefault();
    event.stopPropagation();
    canvas.focus({ preventScroll: true });
    const gesture = {
      pointerId: event.pointerId,
      source: state.file,
      sourceWidth: state.width,
      sourceHeight: state.height,
      aspect: state.style.frameAspect,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      initial: videoFraming(state.style),
      body,
      outputPerClientPixel,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      ready: false,
      completed: false,
      released: false,
    };
    active = gesture;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("dragging");
    editor.player.pauseAtCurrentFrame().then(() => {
      if (active !== gesture) return;
      if (!available() || !sameGeometry(gesture)) return finish(true);
      gesture.ready = true;
      if (gesture.completed) finish();
      else apply(gesture);
    }).catch((error) => {
      if (active !== gesture) return;
      finish(true);
      if (available()) editor.notice(errorMessage(error), "error");
    });
  });
  listen(canvas, "pointermove", (event) => {
    if (!active || active.completed || event.pointerId !== active.pointerId) return;
    active.clientX = event.clientX;
    active.clientY = event.clientY;
    if (!animation) animation = requestAnimationFrame(flush);
  });
  listen(canvas, "pointerup", (event) => {
    if (!active || active.completed || event.pointerId !== active.pointerId) return;
    active.clientX = event.clientX;
    active.clientY = event.clientY;
    finish();
  });
  for (const type of ["pointercancel", "lostpointercapture"]) listen(canvas, type, (event) => {
    if (active && !active.released && event.pointerId === active.pointerId) finish(true);
  });
  listen(document, "keydown", (event) => {
    if (event.key !== "Escape" || (!dragMode && !active)) return;
    if (document.querySelector("dialog[open]") ||
      document.getElementById("info-tooltip")?.hidden === false) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finish(true);
    setDragMode(false);
  }, { capture: true });
  listen(canvas, "keydown", (event) => {
    if (!dragMode || !available() || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (active || event.ctrlKey || event.metaKey || event.altKey) return;
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const key = horizontal ? "videoX" : "videoY";
    Object.assign(state.style, videoFraming({ ...state.style,
      [key]: videoFraming(state.style)[key] + direction * (event.shiftKey ? 5 : 1) }));
    paint();
  });

  update();
  return {
    update,
    dispose() {
      finish(true, false);
      disposed = true;
      setDragMode(false);
      listeners.abort();
    },
  };
}
