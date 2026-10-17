import { $ } from "./dom.js";
import { createEditHistory, snapshotEdit, editEquals } from "./edit-model.js";

// One command path owns trim and clock changes; media never enters edit history.
export function createEditController(editor) {
  const { state, video } = editor;
  const history = createEditHistory(snapshotEdit(state));
  function update() {
    $("timeline-undo").disabled = !state.file || !history.canUndo;
    $("timeline-redo").disabled = !state.file || !history.canRedo;
  }
  function apply(snapshot) {
    const changed = !editEquals(snapshotEdit(state), snapshot);
    Object.assign(state, snapshot);
    update();
    if (changed) editor.refresh("edit");
    return snapshot;
  }
  function change(patch) {
    const next = snapshotEdit({ ...state, ...patch });
    return apply(history.active ? history.update(next) : history.record(next));
  }
  function restore(direction) {
    if (!(direction === "undo" ? history.canUndo : history.canRedo)) return;
    video.pause();
    editor.timeline.clearFeedback();
    apply(history[direction]());
    editor.timeline.populateEvents();
  }
  const controller = {
    change,
    update,
    get active() {
      return history.active;
    },
    begin() {
      history.begin();
      update();
    },
    commit() {
      apply(history.commit());
    },
    cancel() {
      if (history.active) apply(history.cancel());
    },
    reset() {
      history.reset(snapshotEdit(state));
      update();
    },
    undo() {
      restore("undo");
    },
    redo() {
      restore("redo");
    },
  };
  $("timeline-undo").onclick = controller.undo;
  $("timeline-redo").onclick = controller.redo;
  return controller;
}
