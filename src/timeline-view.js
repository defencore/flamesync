import { $, setText } from "./dom.js";
import { bindText, bindAttribute } from "./i18n.js";
import { message } from "./messages.js";
import { clamp, preciseSeconds, videoTimeAt } from "./data.js";
import {
  clampViewport,
  zoomViewport,
  panViewport,
  timeToPixel,
  pixelToTime,
} from "./edit-model.js";

// Every track, cursor, ruler, and pointer uses this single visible time interval.
export function createTimelineView(editor) {
  const { state } = editor;
  let trackData = null,
    tickKey = "";
  const duration = () => state.duration || 1;
  const minSpan = () => Math.max(0.05, state.fps ? 2 / state.fps : 0.05);
  const viewport = () => state.timelineView;
  const percent = (time) => timeToPixel(time, viewport(), 100);
  function setView(next) {
    const bounded = clampViewport(next, duration(), minSpan());
    if (bounded.start === viewport().start && bounded.end === viewport().end)
      return;
    state.timelineView = bounded;
    render();
    updatePlayhead(editor.player?.currentTime() ?? 0, false);
  }
  function fit() {
    setView({ start: 0, end: duration() });
  }
  function fitSelection() {
    if (state.file) setView({ start: state.start, end: state.end });
  }
  function zoom(factor, anchor = editor.player.currentTime()) {
    if (state.file)
      setView(zoomViewport(viewport(), factor, anchor, duration(), minSpan()));
  }
  function pan(delta) {
    if (state.file) setView(panViewport(viewport(), delta, duration()));
  }
  function ensureVisible(time) {
    if (editor.edits.active) return;
    const view = viewport(),
      span = view.end - view.start;
    if (time < view.start || time > view.end)
      setView({ start: time - span * 0.3, end: time + span * 0.7 });
  }
  function updatePlayhead(time, follow = true) {
    if (follow && !editor.video.paused && !editor.edits.active)
      ensureVisible(time);
    const position = percent(time),
      visible = position >= 0 && position <= 100;
    const scrubber = $("scrubber");
    scrubber.min = String(viewport().start);
    scrubber.max = String(viewport().end);
    scrubber.value = String(clamp(time, viewport().start, viewport().end));
    $("scrubber-rail").classList.toggle("playhead-outside", !visible);
    $("timeline-playhead").hidden = !visible;
    $("timeline-playhead").style.left = `${position}%`;
    $("scrubber-rail").style.setProperty(
      "--playhead-position",
      `${clamp(position, 0, 100)}%`,
    );
  }
  function drawTrack() {
    const data = state.data,
      view = viewport();
    const width = $("tracks-body").clientWidth;
    if (!width) return;
    const ratio = window.devicePixelRatio || 1;
    const key = `${view.start}:${view.end}:${state.offset}:${state.timeScale}:${width}:${ratio}`;
    if (trackData?.data === data && trackData?.key === key) return;
    trackData = { data, key };
    const canvas = $("track-curve"),
      ctx = canvas.getContext("2d");
    const from = data
      ? Math.max(
          view.start,
          videoTimeAt(data.start, state.offset, state.timeScale),
        )
      : view.start;
    const to = data
      ? Math.min(view.end, videoTimeAt(data.end, state.offset, state.timeScale))
      : view.end;
    const visibleWidth = Math.max(
      1,
      ((to - from) / (view.end - view.start)) * width,
    );
    canvas.width = Math.round(visibleWidth * ratio);
    canvas.height = Math.round(32 * ratio);
    canvas.style.width = `${visibleWidth}px`;
    canvas.style.left = data
      ? `${((from - videoTimeAt(data.start, state.offset, state.timeScale)) / (view.end - view.start)) * width}px`
      : "0";
    if (!data || to <= from) return;
    ctx.scale(ratio, ratio);
    ctx.strokeStyle = "#b9783a";
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    let connected = false;
    for (let i = 0; i < state.reduced.length; i++) {
      const point = state.reduced[i];
      if (!Number.isFinite(point.thrust)) { connected = false; continue; }
      const x =
        ((videoTimeAt(point.t, state.offset, state.timeScale) - from) /
          (to - from)) *
        visibleWidth;
      const y = 28 - (Math.max(0, point.thrust) / (data.peakThrust || 1)) * 24;
      if (!connected || point.thrustGapBefore) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      connected = true;
    }
    ctx.stroke();
  }
  function render() {
    const view = viewport(),
      span = view.end - view.start;
    const selection = $("trim-selection");
    selection.style.left = `${percent(state.start)}%`;
    selection.style.right = "auto";
    selection.style.width = `${(((state.end || duration()) - state.start) / span) * 100}%`;
    // Handles remain visible at the viewport boundary only when the actual edit is visible.
    for (const [edge, value] of [
      ["start", state.start],
      ["end", state.end],
    ]) {
      const handle = $(`trim-handle-${edge}`);
      handle.hidden = value < view.start - 1e-8 || value > view.end + 1e-8;
      handle.setAttribute("aria-valuemax", String(duration()));
      handle.setAttribute("aria-valuenow", String(value));
      handle.setAttribute("aria-disabled", String(!state.file));
      bindAttribute(handle, "aria-valuetext", "{value} s", {
        value: preciseSeconds(value),
      });
    }
    const data = state.data;
    const csv = $("csv-track");
    csv.style.width =
      data && state.file
        ? `${((data.duration * state.timeScale) / span) * 100}%`
        : "100%";
    csv.style.left =
      data && state.file
        ? `${percent(videoTimeAt(data.start, state.offset, state.timeScale))}%`
        : "0";
    const trackWidth = $("tracks-body").clientWidth;
    const csvStart = data
      ? videoTimeAt(data.start, state.offset, state.timeScale)
      : 0;
    $("csv-track-name").style.left =
      `${Math.max(9, (-percent(csvStart) / 100) * trackWidth + 9)}px`;
    $("csv-track-name").style.maxWidth =
      `${Math.max(0, Math.min(trackWidth - 18, data ? ((data.duration * state.timeScale) / span) * trackWidth - 18 : trackWidth))}px`;
    csv.setAttribute("aria-valuenow", String(state.offset));
    csv.setAttribute(
      "aria-valuemin",
      String(Math.min(state.offset, data ? -data.end * state.timeScale : 0)),
    );
    csv.setAttribute(
      "aria-valuemax",
      String(
        Math.max(
          state.offset,
          duration() - (data?.start ?? 0) * state.timeScale,
        ),
      ),
    );
    bindAttribute(csv, "aria-valuetext", "Offset {value0} s", {
      value0: preciseSeconds(state.offset),
    });
    csv.setAttribute("aria-disabled", String(!(state.file && data)));
    const ignition = videoTimeAt(
      state.csvAnchor,
      state.offset,
      state.timeScale,
    );
    $("timeline-ignition").hidden =
      !data || !state.file || ignition < view.start || ignition > view.end;
    $("timeline-ignition").style.left = `${percent(ignition)}%`;
    const key = `${Boolean(state.file)}:${view.start}:${view.end}`;
    if (key !== tickKey) {
      tickKey = key;
      $("timeline-ticks").replaceChildren(
        ...Array.from({ length: 5 }, (_, i) => {
          const label = document.createElement("span");
          label.style.left = `${i * 25}%`;
          bindText(
            label,
            state.file
              ? message("{value0}s", {
                  value0: (view.start + (span * i) / 4).toFixed(
                    span < 1 ? 3 : span < 10 ? 2 : 1,
                  ),
                })
              : i === 0
                ? "0.0s"
                : "—",
          );
          return label;
        }),
      );
    }
    bindText("timeline-viewport-label", "{start}–{end} s", {
      start: view.start.toFixed(3),
      end: view.end.toFixed(3),
    });
    setText("timeline-zoom-value", `${(duration() / span).toFixed(1)}×`);
    const scroll = $("timeline-scroll");
    scroll.max = String(Math.max(0, duration() - span));
    scroll.value = String(view.start);
    scroll.disabled = !state.file || span >= duration() - 1e-7;
    $("timeline-navigation").hidden = scroll.disabled;
    for (const id of [
      "timeline-fit",
      "timeline-fit-selection",
      "timeline-snap",
      "timeline-loop",
      "clear-trim",
    ])
      $(id).disabled = !state.file;
    $("timeline-zoom-in").disabled = !state.file || span <= minSpan() + 1e-7;
    $("timeline-zoom-out").disabled = !state.file || span >= duration() - 1e-7;
    $("timeline-snap").setAttribute("aria-pressed", String(state.snapping));
    $("timeline-loop").setAttribute(
      "aria-pressed",
      String(state.loopSelection),
    );
    drawTrack();
  }
  $("timeline-zoom-in").onclick = () => zoom(2);
  $("timeline-zoom-out").onclick = () => zoom(0.5);
  $("timeline-fit").onclick = fit;
  $("timeline-fit-selection").onclick = fitSelection;
  $("timeline-scroll").oninput = (event) =>
    pan(Number(event.target.value) - viewport().start);
  $("timeline-snap").onclick = () => {
    state.snapping = !state.snapping;
    render();
  };
  $("timeline-loop").onclick = () => {
    state.loopSelection = !state.loopSelection;
    render();
  };
  const observer = new ResizeObserver(render);
  observer.observe($("tracks-body"));
  return {
    render,
    dispose() {
      observer.disconnect();
    },
    updatePlayhead,
    zoom,
    fit,
    fitSelection,
    pan,
    ensureVisible,
    viewport,
    pointerTime(clientX) {
      const rect = $("tracks-body").getBoundingClientRect();
      return pixelToTime(clientX - rect.left, viewport(), rect.width);
    },
    reset() {
      state.timelineView = { start: 0, end: duration() };
      tickKey = "";
      render();
    },
  };
}
