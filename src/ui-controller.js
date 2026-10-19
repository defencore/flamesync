import { $, bindTabs } from "./dom.js";
import { compositionSize, formatValue } from "./data.js";
import { displayThrust, displayPressure } from "./units.js";
import { bindText, bindAttribute } from "./i18n.js";
import { message } from "./messages.js";
import { videoTimeAt } from "./data.js";
export function createUIController(editor) {
  const { state, canvas } = editor;
  function updateExportSummary() {
    if (state.file)
      bindText("export-duration", "{value} s", {
        value: (state.end - state.start).toFixed(3),
      });
    else $("export-duration").textContent = "—";
    const size = compositionSize(
      state.width,
      state.height,
      Number($("export-resolution").value),
      state.style.frameAspect,
    );
    $("export-dimensions").textContent = state.file
      ? `${size.width} × ${size.height}`
      : "—";
    const theoryRequested = state.theory?.enabled && state.theory?.file;
    const theoryInvalid = theoryRequested && !state.theory.valid;
    const theoryUnmapped = theoryRequested && state.data &&
      !state.theory.loading && !theoryInvalid &&
      !editor.theory?.forMeasurement(state.measurement);
    const unavailable =
      !(state.file && state.data) ||
      state.loading ||
      state.csvLoading || state.theory?.loading ||
      theoryInvalid || theoryUnmapped ||
      state.exporting;
    const overlaps =
      state.data &&
      videoTimeAt(state.data.end, state.offset, state.timeScale) >
        state.start &&
      videoTimeAt(state.data.start, state.offset, state.timeScale) < state.end;
    for (const button of document.querySelectorAll("[data-save-video]"))
      button.disabled = unavailable || !overlaps;
    const status =
      state.loading || state.csvLoading || state.theory?.loading
        ? "Reading your files…"
        : theoryInvalid
          ? "Correct the theoretical profile settings or disable theory before saving."
        : state.exporting
          ? "Creating your video. Keep this tab open."
          : !state.file && !state.data
            ? "Add a video and CSV log to enable saving."
            : !state.file
              ? "Add a video to enable saving."
              : !state.data
                ? "Add a CSV log to enable saving."
                : theoryUnmapped
                  ? "Set matching A/B markers, choose Original CSV time for theory, or disable theory before saving."
                : !overlaps
                  ? "Move the CSV track into the selected video range to save."
                  : message(
                      "Ready to save · {format} · {duration} s · {width} × {height}",
                      {
                        format: $("export-format").value.toUpperCase(),
                        duration: (state.end - state.start).toFixed(3),
                        width: size.width,
                        height: size.height,
                      },
                    );
    bindText("save-status", status);
    bindText(
      "export-layout",
      state.style.layout === "full" ? "Full frame + data" : "On footage",
    );
  }

  function updateAvailability() {
    for (const id of [
      "play-button",
      "jump-start",
      "frame-set-in",
      "frame-set-out",
      "scrubber",
      "trim-start",
      "trim-end",
      "set-in",
      "set-out",
      "reset-timeline",
    ]) {
      $(id).disabled = !state.file;
    }
    $("set-in").disabled =
      $("set-out").disabled =
      $("frame-set-in").disabled =
      $("frame-set-out").disabled =
        !state.file || !state.frameTimes.length;
    $("empty-state").hidden = Boolean(state.file);
    bindText(
      "preview-tag",
      state.file
        ? state.data
          ? "OUTPUT PREVIEW"
          : "AWAITING CSV"
        : "OVERLAY PREVIEW",
    );
    bindAttribute(
      canvas,
      "aria-label",
      state.data
        ? "Video with synchronized thrust and pressure overlay"
        : "Video preview. Waiting for a CSV log to display thrust and pressure.",
    );
  }

  function updateDataSummary() {
    const data = state.data;
    $("data-summary").hidden = !data;
    $("csv-drop").setAttribute("aria-busy", String(state.csvLoading));
    bindText(
      "csv-units-summary",
      state.csvLoading
        ? "Reading CSV…"
        : data
          ? message("Time: {time} · Thrust: {thrust} · Pressure: {pressure}", {
              time:
                data.sourceUnits.time === "us" ? "µs" : data.sourceUnits.time,
              thrust: data.sourceUnits.thrust,
              pressure: data.sourceUnits.pressure,
            })
          : "Set the units recorded in the source file.",
    );
    if (!data) return;
    $("summary-samples").textContent =
      data.points.length.toLocaleString("en-US");
    bindText("summary-duration", "{value} s", {
      value: data.duration.toFixed(3),
    });
    $("summary-thrust").textContent =
      `${formatValue(displayThrust(data.peakThrust, state.style.thrustUnit))} ${state.style.thrustUnit}`;
    $("summary-pressure").textContent =
      `${formatValue(displayPressure(data.peakPressure, state.style.pressureUnit))} ${state.style.pressureUnit}`;
    $("summary-impulse").textContent =
      `${formatValue(displayThrust(data.impulse, state.style.thrustUnit))} ${state.style.thrustUnit}·s`;
  }

  const inspector = bindTabs(document.querySelector(".inspector .tabs"));
  bindTabs($("analysis-tabs"), (tab) => {
    if (tab.dataset.tool === "measurement") editor.measurements.draw();
  });
  $("export-resolution").onchange = () => editor.refresh();
  function openExportSettings() {
    inspector.selectValue("export");
    $("export-format").focus();
  }
  $("export-settings").onclick = $("save-settings").onclick =
    openExportSettings;
  $("export-format").addEventListener("change", () => editor.refresh());
  $("go-export").onclick = () => {
    inspector.selectValue("overlay");
    $("tab-overlay").focus();
  };
  $("help-open").onclick = () => $("help-dialog").showModal();
  $("help-close").onclick = () => $("help-dialog").close();
  return {
    updateExport: updateExportSummary,
    update() {
      updateAvailability();
      updateDataSummary();
      updateExportSummary();
    },
  };
}
