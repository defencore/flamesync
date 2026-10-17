import { $ } from "./dom.js";
import { bindText } from "./i18n.js";
import { message, errorMessage, UserError } from "./messages.js";
import {
  alignOffset,
  fitTimeMapping,
  preciseSeconds,
  rescaleOffset,
  validateTimeScale,
  videoTimeAt,
} from "./data.js";

export function createSynchronizationController(editor) {
  const { state } = editor;
  let requestVersion = 0;
  const events = {
    a: { csv: NaN, video: NaN },
    b: { csv: NaN, video: NaN },
  };
  const anchorDrafts = { start: null, end: null };
  const anchorInputs = [
    ["csv-anchor", "csvAnchor", "start"],
    ["csv-end-anchor", "csvEndAnchor", "end"],
  ];

  function renderAnchors() {
    for (const [id, key, which] of anchorInputs) {
      const draft = anchorDrafts[which];
      $(id).value = draft ? draft.value : preciseSeconds(state[key]);
      if (draft) $(id).setAttribute("aria-invalid", "true");
      else $(id).removeAttribute("aria-invalid");
    }
  }

  function renderAnchorValidation() {
    const invalid = Object.values(anchorDrafts).filter(Boolean);
    $("sync-anchor-error").hidden = !anchorDrafts.start;
    bindText("sync-anchor-error", anchorDrafts.start?.error ?? "");
    if (invalid.length) {
      bindText(
        "end-alignment-status",
        invalid.map((draft) => draft.error),
      );
      $("end-alignment-status").classList.add("error");
    }
  }

  function clearAnchorDrafts() {
    const invalid = anchorDrafts.start || anchorDrafts.end;
    anchorDrafts.start = anchorDrafts.end = null;
    renderAnchors();
    renderAnchorValidation();
    if (invalid) {
      bindText("end-alignment-status", "");
      $("end-alignment-status").classList.remove("error");
    }
  }

  function clearFeedback() {
    requestVersion++;
    for (const id of ["fit-status", "end-alignment-status"]) {
      bindText(id, "");
      $(id).classList.remove("error");
    }
    renderAnchorValidation();
  }

  function validateAnchor(value, which) {
    if (
      !state.data ||
      !Number.isFinite(value) ||
      value < state.data.start ||
      value > state.data.end
    )
      throw new UserError(
        which === "start"
          ? "Choose a CSV ignition time within the loaded log before aligning."
          : "Enter an end event within the CSV time range.",
      );
    return value;
  }

  function setAnchors(start, end) {
    validateAnchor(start, "start");
    validateAnchor(end, "end");
    clearAnchorDrafts();
    clearFeedback();
    editor.edits.change({ csvAnchor: start, csvEndAnchor: end });
    update();
  }

  function setOffset(value) {
    if (!Number.isFinite(value)) return;
    clearFeedback();
    editor.edits.change({ offset: value });
  }

  function setTimeScale(value, pivot = state.csvAnchor) {
    if (!state.data || !state.file) return;
    try {
      validateTimeScale(value);
      validateAnchor(pivot, "start");
      const offset = rescaleOffset(state.offset, state.timeScale, value, pivot);
      clearFeedback();
      editor.edits.change({ offset, timeScale: value });
    } catch (error) {
      editor.notice(errorMessage(error), "error");
      editor.refresh();
    }
  }

  // Frame-based edits share one generation, so a later action supersedes a pending seek.
  async function atSelectedFrame(apply, onError) {
    if (!state.file || !state.data) return;
    const version = ++requestVersion;
    const selection = {
      file: state.file,
      data: state.data,
      offset: state.offset,
      timeScale: state.timeScale,
      csvAnchor: state.csvAnchor,
      csvEndAnchor: state.csvEndAnchor,
    };
    const current = () =>
      version === requestVersion &&
      Object.entries(selection).every(([key, value]) => state[key] === value);
    try {
      const time = await editor.player.pauseAtCurrentFrame();
      if (current()) apply(time, selection);
    } catch (error) {
      if (current()) onError(error);
    }
  }

  function alignIgnition() {
    if (anchorDrafts.start) {
      renderAnchorValidation();
      return Promise.resolve();
    }
    return atSelectedFrame(
      (time, selection) => {
        const anchor = validateAnchor(selection.csvAnchor, "start");
        setOffset(alignOffset(time, anchor, selection.timeScale));
        editor.notice(
          message(
            "Aligned CSV {value0} s with video {value1} s. The selected frame is paused.",
            { value0: preciseSeconds(anchor), value1: preciseSeconds(time) },
          ),
        );
      },
      (error) => editor.notice(errorMessage(error), "error"),
    );
  }

  function showEndError(error) {
    bindText("end-alignment-status", errorMessage(error));
    $("end-alignment-status").classList.add("error");
  }

  function alignEnd() {
    if (anchorDrafts.start || anchorDrafts.end) {
      renderAnchorValidation();
      return Promise.resolve();
    }
    return atSelectedFrame((time, selection) => {
      const csvStart = validateAnchor(selection.csvAnchor, "start");
      const csvEnd = validateAnchor(selection.csvEndAnchor, "end");
      const videoStart = videoTimeAt(
        csvStart,
        selection.offset,
        selection.timeScale,
      );
      const mapping = fitTimeMapping(csvStart, videoStart, csvEnd, time);
      clearFeedback();
      editor.edits.change(mapping);
      bindText(
        "end-alignment-status",
        message(
          "End aligned at video {value0} s. Ignition stays at {value1} s. Telemetry duration: {value2}%.",
          {
            value0: time.toFixed(3),
            value1: videoStart.toFixed(3),
            value2: (mapping.timeScale * 100).toFixed(3),
          },
        ),
      );
    }, showEndError);
  }

  function readEventMapping() {
    const { a, b } = events;
    if (
      !state.data ||
      !state.file ||
      ![a.csv, a.video, b.csv, b.video].every(Number.isFinite) ||
      [a.csv, b.csv].some(
        (time) => time < state.data.start || time > state.data.end,
      ) ||
      [a.video, b.video].some((time) => time < 0 || time > state.duration)
    )
      throw new UserError(
        "Choose events within the loaded CSV and video ranges.",
      );
    return {
      ...fitTimeMapping(a.csv, a.video, b.csv, b.video),
      csvInterval: b.csv - a.csv,
      videoInterval: b.video - a.video,
    };
  }

  // Event drafts have their own clock comparison; dragging the timeline never re-parses them.
  function updateClockComparison() {
    $("clock-comparison").hidden = true;
    try {
      const mapping = readEventMapping();
      bindText("clock-csv-interval", "{value0} s", {
        value0: preciseSeconds(mapping.csvInterval),
      });
      bindText("clock-video-interval", "{value0} s", {
        value0: preciseSeconds(mapping.videoInterval),
      });
      bindText("clock-required-scale", "{value0}%", {
        value0: (mapping.timeScale * 100).toFixed(3),
      });
      $("clock-comparison").hidden = false;
    } catch {
      // Incomplete event pairs cannot establish a clock ratio.
    }
  }

  function writeEvent(name, kind) {
    const value = events[name][kind];
    $(`point-${name}-${kind}`).value = Number.isFinite(value)
      ? preciseSeconds(value)
      : "";
  }

  function populateEvents() {
    clearAnchorDrafts();
    for (const [name, csv] of [
      ["a", state.csvAnchor],
      ["b", state.csvEndAnchor],
    ]) {
      events[name] = {
        csv: state.data ? csv : NaN,
        video:
          state.data && state.file
            ? videoTimeAt(csv, state.offset, state.timeScale)
            : NaN,
      };
      for (const kind of ["csv", "video"]) writeEvent(name, kind);
    }
    updateClockComparison();
    update();
  }

  function resetAnchors() {
    clearFeedback();
    editor.edits.change({
      csvAnchor: state.data?.ignition ?? 0,
      csvEndAnchor: state.data?.end ?? 0,
    });
    populateEvents();
  }

  function showFitError(error) {
    bindText("fit-status", errorMessage(error));
    $("fit-status").classList.add("error");
  }

  for (const name of ["a", "b"]) {
    $(`capture-${name}`).onclick = () =>
      atSelectedFrame((time) => {
        events[name].video = time;
        writeEvent(name, "video");
        updateClockComparison();
        $("fit-status").classList.remove("error");
        bindText("fit-status", "Captured event {value0} at video {value1} s.", {
          value0: name.toUpperCase(),
          value1: time.toFixed(3),
        });
      }, showFitError);
    for (const kind of ["csv", "video"])
      $(`point-${name}-${kind}`).addEventListener("input", (event) => {
        requestVersion++;
        events[name][kind] =
          event.target.value === "" ? NaN : Number(event.target.value);
        bindText("fit-status", "");
        $("fit-status").classList.remove("error");
        updateClockComparison();
      });
  }

  $("fit-events").onclick = () => {
    try {
      const { offset, timeScale } = readEventMapping();
      clearFeedback();
      editor.edits.change({ offset, timeScale });
      bindText("fit-status", "Both events matched · {value0}% duration.", {
        value0: (timeScale * 100).toFixed(3),
      });
      editor.notice("");
    } catch (error) {
      showFitError(error);
    }
  };

  $("sync-offset").onchange = (event) =>
    setOffset(
      event.target.value === "" ? state.offset : Number(event.target.value),
    );
  $("offset-minus").onclick = () => setOffset(state.offset - 0.01);
  $("offset-plus").onclick = () => setOffset(state.offset + 0.01);
  for (const [id, key, which] of anchorInputs)
    $(id).onchange = (event) => {
      try {
        const value =
          event.target.value === "" ? NaN : Number(event.target.value);
        validateAnchor(value, which);
        anchorDrafts[which] = null;
        clearFeedback();
        editor.edits.change({ [key]: value });
      } catch (error) {
        requestVersion++;
        anchorDrafts[which] = {
          value: event.target.value,
          error: errorMessage(error),
        };
      }
      update();
    };
  $("align-ignition").onclick = alignIgnition;
  $("align-end").onclick = alignEnd;
  $("stretch-percent").onchange = (event) =>
    setTimeScale(Number(event.target.value) / 100);
  $("reset-stretch").onclick = () => setTimeScale(1);
  $("analysis-controls").addEventListener("toggle", () => editor.refresh());

  function update() {
    const unavailable = !(state.file && state.data);
    for (const id of [
      "csv-anchor",
      "sync-offset",
      "offset-minus",
      "offset-plus",
      "align-ignition",
      "align-end",
      "csv-end-anchor",
      "stretch-percent",
      "reset-stretch",
      "stretch-handle",
      "point-a-csv",
      "point-a-video",
      "point-b-csv",
      "point-b-video",
      "capture-a",
      "capture-b",
      "fit-events",
    ])
      $(id).disabled = unavailable;
    $("align-ignition").disabled = unavailable || Boolean(anchorDrafts.start);
    $("align-end").disabled =
      unavailable || Boolean(anchorDrafts.start || anchorDrafts.end);
    $("sync-offset").value = preciseSeconds(state.offset);
    renderAnchors();
    renderAnchorValidation();
    for (const id of ["csv-anchor", "csv-end-anchor"])
      if (state.data) {
        $(id).min = String(state.data.start);
        $(id).max = String(state.data.end);
      }
    bindText("sync-readout", "Offset {value0} s", {
      value0: preciseSeconds(state.offset),
    });
    const alignedStart = state.data
      ? videoTimeAt(state.csvAnchor, state.offset, state.timeScale)
      : null;
    bindText(
      "aligned-start-time",
      alignedStart === null
        ? message("—")
        : message("video {value0} s", { value0: preciseSeconds(alignedStart) }),
    );
    $("jump-alignment").disabled =
      !state.file ||
      Boolean(anchorDrafts.start) ||
      alignedStart === null ||
      alignedStart < 0 ||
      alignedStart >= state.duration;
    $("stretch-percent").value = (state.timeScale * 100).toFixed(3);
    const modified = Math.abs(state.timeScale - 1) > 1e-8;
    bindText(
      "stretch-badge",
      modified
        ? message("{value0}% · modified timing", {
            value0: (state.timeScale * 100).toFixed(3),
          })
        : "100% · original timing",
    );
    $("stretch-badge").classList.toggle("modified", modified);
    bindText(
      "telemetry-duration",
      state.data
        ? message("{value0} s on video · {value1} s in CSV", {
            value0: (state.data.duration * state.timeScale).toFixed(3),
            value1: state.data.duration.toFixed(3),
          })
        : "No CSV loaded",
    );
    $("stretch-handle").hidden = !$("analysis-controls").open;
    $("stretch-handle").setAttribute(
      "aria-valuenow",
      (state.timeScale * 100).toFixed(3),
    );
  }

  return {
    update,
    alignIgnition,
    alignEnd,
    setOffset,
    setTimeScale,
    setAnchors,
    resetAnchors,
    populateEvents,
    clearFeedback,
  };
}
