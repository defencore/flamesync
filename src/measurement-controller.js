import { message, errorMessage } from "./messages.js";
import { bindText, bindAttribute, getLocale } from "./i18n.js";
import { $ } from "./dom.js";
import { clamp } from "./data.js";
import {
  detectBurnInterval,
  intervalStats,
  adjacentTelemetryTime,
} from "./measurement.js";
import {
  drawMeasurementChart,
  measurementPlotBox,
} from "./measurement-chart.js";

export function createMeasurementController(editor) {
  const { state } = editor;
  const plot = $("measurement-plot");
  const canvas = $("measurement-chart");
  const ctx = canvas.getContext("2d");
  const precise = (value) => Number(value.toFixed(6)).toString();
  const complete = () =>
    Boolean(state.measurement?.startSet && state.measurement?.endSet);
  function composition() {
    const m = state.measurement;
    return complete()
      ? { start: m.start, end: m.end, visible: state.showMeasurement }
      : null;
  }
  let plotCache = null;
  let statsCache = null;
  function draw() {
    const width = plot.clientWidth,
      height = plot.clientHeight;
    if (!width || !height) return;
    if (
      plotCache?.locale === getLocale() &&
      plotCache?.data === state.data &&
      plotCache?.measurement === state.measurement &&
      plotCache?.width === width &&
      plotCache?.height === height &&
      plotCache?.thrustUnit === state.style.thrustUnit &&
      plotCache?.pressureUnit === state.style.pressureUnit
    )
      return;
    plotCache = {
      locale: getLocale(),
      data: state.data,
      measurement: state.measurement,
      width,
      height,
      thrustUnit: state.style.thrustUnit,
      pressureUnit: state.style.pressureUnit,
    };
    const ratio = window.devicePixelRatio || 1;
    const w = Math.round(width * ratio),
      h = Math.round(height * ratio);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const box = drawMeasurementChart(
      ctx,
      width,
      height,
      state.data,
      state.reduced,
      state.measurement,
      state.style,
    );
    if (state.data && state.measurement)
      for (const name of ["start", "end"]) {
        const x =
          box.x +
          ((state.measurement[name] - state.data.start) / state.data.duration) *
            box.width;
        $(`measure-marker-${name}`).style.left = `${x}px`;
      }
  }
  function update(error = "") {
    const data = state.data,
      m = state.measurement;
    const ready = complete();
    for (const id of [
      "measure-start",
      "measure-end",
      "measure-threshold",
      "measure-detect",
      "measure-marker-start",
      "measure-marker-end",
    ])
      $(id).disabled = !data;
    $("measure-use-sync").disabled = $("show-measurement").disabled = !ready;
    for (const name of ["start", "end"]) {
      const input = $(`measure-${name}`),
        handle = $(`measure-marker-${name}`);
      input.value = m && m[`${name}Set`] ? precise(m[name]) : "";
      handle.hidden = !data;
      if (data && m) {
        input.min = String(data.start);
        input.max = String(data.end);
        handle.setAttribute("aria-valuemin", String(data.start));
        handle.setAttribute("aria-valuemax", String(data.end));
        handle.setAttribute("aria-valuenow", String(m[name]));
        bindAttribute(handle, "aria-valuetext", "{time} CSV seconds", {
          time: m[name].toFixed(3),
        });
      }
    }
    if (
      ready &&
      (!statsCache ||
        statsCache.data !== data ||
        statsCache.start !== m.start ||
        statsCache.end !== m.end)
    )
      statsCache = {
        data,
        start: m.start,
        end: m.end,
        ...intervalStats(data, m.start, m.end),
      };
    const stats = ready
      ? {
          ...statsCache,
          videoDuration: statsCache.csvDuration * state.timeScale,
        }
      : null;
    bindText(
      $("measure-duration"),
      stats
        ? message("{value0} s", { value0: stats.csvDuration.toFixed(3) })
        : message("—"),
    );
    bindText(
      $("measure-video-duration"),
      stats
        ? message("{value0} s", { value0: stats.videoDuration.toFixed(3) })
        : message("—"),
    );
    $("measure-video-result").hidden =
      !stats || !state.file || Math.abs(state.timeScale - 1) < 1e-8;
    bindText(
      $("measurement-origin"),
      !m
        ? message("Set start and end markers")
        : m.origin === "automatic"
          ? message("{value0}% of peak thrust", { value0: m.percent })
          : message("Manual markers"),
    );
    bindText(
      $("measurement-summary"),
      stats
        ? message("Burn interval {value0} s · CSV", {
            value0: stats.csvDuration.toFixed(3),
          })
        : data
          ? message("Set both markers")
          : message("Load a CSV log"),
    );
    const messages = [];
    if (!data) messages.push("Load a CSV log to measure thrust duration.");
    else if (m) {
      if (m.origin === "automatic") {
        messages.push(...m.detection.warnings);
      } else {
        if (!m.startSet) messages.push("Set start A manually.");
        if (!m.endSet) messages.push("Set end B manually.");
      }
      if (stats?.gaps)
        messages.push(
          message(
            "Data gaps inside the interval: {count}. Elapsed time includes missing samples.",
            { count: stats.gaps },
          ),
        );
    }
    bindText("measurement-status", error || messages);
    $("measurement-status").classList.toggle("error", Boolean(error));
    draw();
  }
  function detect(reset = false) {
    if (!state.data) return;
    if (reset) $("measure-threshold").value = "5";
    try {
      const percent = Number($("measure-threshold").value);
      const detection = detectBurnInterval(state.data, percent);
      state.measurement = {
        start: detection.start ?? state.data.start,
        end: detection.end ?? state.data.end,
        startSet: detection.start !== null,
        endSet: detection.end !== null,
        origin: "automatic",
        detection,
        percent,
      };
      update();
      editor.preview.render();
    } catch (error) {
      update(errorMessage(error));
    }
  }
  function setMarker(name, value, drag = false) {
    if (!state.data || !state.measurement) return;
    const data = state.data,
      m = state.measurement;
    if (drag) {
      const minimumSpan = Math.min(0.001, data.duration / 100);
      value = clamp(
        value,
        name === "start" ? data.start : m.start + minimumSpan,
        name === "start" ? m.end - minimumSpan : data.end,
      );
    }
    try {
      const next = {
        ...m,
        [name]: value,
        [`${name}Set`]: true,
        origin: "manual",
      };
      intervalStats(data, next.start, next.end, state.timeScale);
      state.measurement = next;
      update();
      editor.preview.render();
    } catch (error) {
      update(errorMessage(error));
    }
  }
  for (const name of ["start", "end"]) {
    $(`measure-${name}`).onchange = (event) =>
      setMarker(
        name,
        event.target.value === "" ? NaN : Number(event.target.value),
      );
    $(`measure-marker-${name}`).onkeydown = (event) => {
      if (
        !state.data ||
        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const value =
        event.key === "Home"
          ? state.data.start
          : event.key === "End"
            ? state.data.end
            : adjacentTelemetryTime(
                state.data,
                state.measurement[name],
                event.key === "ArrowRight" ? 1 : -1,
              );
      setMarker(name, value, true);
    };
  }
  plot.addEventListener("pointerdown", (event) => {
    if (!state.data || !state.measurement || event.button !== 0) return;
    const rect = plot.getBoundingClientRect(),
      box = measurementPlotBox(rect.width, rect.height);
    const timeAt = (e) =>
      state.data.start +
      clamp((e.clientX - rect.left - box.x) / box.width, 0, 1) *
        state.data.duration;
    const marker = event.target.closest("[data-measure-marker]");
    if (
      !marker &&
      (event.clientY - rect.top < box.y ||
        event.clientY - rect.top > box.y + box.height)
    )
      return;
    const t = timeAt(event);
    const name =
      marker?.dataset.measureMarker ||
      (Math.abs(t - state.measurement.start) <=
      Math.abs(t - state.measurement.end)
        ? "start"
        : "end");
    event.preventDefault();
    event.stopPropagation();
    $(`measure-marker-${name}`).focus({ preventScroll: true });
    plot.setPointerCapture(event.pointerId);
    if (!marker) setMarker(name, t, true);
    const move = (e) => setMarker(name, timeAt(e), true);
    const finish = () => {
      plot.removeEventListener("pointermove", move);
      plot.removeEventListener("pointerup", finish);
      plot.removeEventListener("pointercancel", finish);
      plot.removeEventListener("lostpointercapture", finish);
    };
    plot.addEventListener("pointermove", move);
    plot.addEventListener("pointerup", finish);
    plot.addEventListener("pointercancel", finish);
    plot.addEventListener("lostpointercapture", finish);
  });
  $("measure-detect").onclick = () => detect();
  $("show-measurement").onchange = (event) => {
    state.showMeasurement = event.target.checked;
    editor.preview.render();
  };
  $("measure-use-sync").onclick = () => {
    if (!complete()) return;
    editor.timeline.setAnchors(state.measurement.start, state.measurement.end);
    editor.notice(
      "Measurement A/B copied to synchronization events. Align the start in the video, then use Align end here in Advanced.",
    );
  };

  const observer = new ResizeObserver(draw);
  observer.observe(plot);
  return {
    composition,
    update,
    detect,
    draw,
    dispose() {
      observer.disconnect();
    },
  };
}
