export function bindEditorShortcuts(editor) {
  function onKeyDown(event) {
    const target = event.target;
    if (
      event.defaultPrevented ||
      event.altKey ||
      target?.closest?.(
        'input,select,textarea,[role="slider"],[role="textbox"],[contenteditable]:not([contenteditable="false"])',
      ) ||
      document.querySelector("dialog[open]")
    )
      return;
    const key = event.key.toLowerCase();
    const code = event.code;
    if (event.ctrlKey || event.metaKey) {
      if (key === "z" || code === "KeyZ") {
        event.preventDefault();
        if (event.shiftKey) editor.edits.redo();
        else editor.edits.undo();
      } else if (key === "y" || code === "KeyY") {
        event.preventDefault();
        editor.edits.redo();
      }
      return;
    }
    if (!editor.state.file) return;

    let action;
    if (
      (code === "Space" || key === " ") &&
      !target?.closest?.('button,[role="button"],summary,a[href]')
    )
      action = () => editor.player.togglePlay();
    else if (key === "arrowleft" || key === "arrowright")
      action = () =>
        editor.player.stepFrame(
          key === "arrowleft" ? -1 : 1,
          event.shiftKey ? 10 : 1,
        );
    else if (key === "home") action = () => editor.player.goToSelectedStart();
    else if (key === "end") action = () => editor.player.goToSelectedEnd();
    else if (key === "i" || code === "KeyI")
      action = () => editor.player.markIn();
    else if (key === "o" || code === "KeyO")
      action = () => editor.player.markOut();
    else if (key === "s" || code === "KeyS")
      action = () => editor.timeline.alignIgnition();
    else if (key === "+" || key === "=") action = () => editor.timeline.zoom(2);
    else if (key === "-") action = () => editor.timeline.zoom(0.5);
    else if (key === "\\" || code === "Backslash")
      action = () => editor.timeline.fit();
    else if (key === "f" || code === "KeyF")
      action = () => editor.timeline.fitSelection();

    if (action) {
      event.preventDefault();
      action();
    }
  }

  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}
