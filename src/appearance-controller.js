import { $ } from "./dom.js";
import { defaultMetadata } from "./overlay.js";
export function bindAppearanceControls(editor) {
  const { state } = editor;
  $("test-title").oninput = (event) => {
    state.style.title = event.target.value;
    editor.refresh();
  };
  $("presentation-layout").onchange = (event) => {
    state.style.layout = event.target.value;
    if (state.style.layout === "stacked")
      state.style.opacity = Math.max(70, Math.min(95, state.style.opacity));
    editor.refresh();
  };
  $("chart-range").onchange = (event) => {
    state.style.chartRange = event.target.value;
    editor.refresh();
  };
  $("frame-aspect").onchange = (event) => {
    state.style.frameAspect = event.target.value;
    editor.refresh();
  };
  $("show-details").onchange = (event) => {
    state.style.showDetails = event.target.checked;
    editor.refresh();
  };
  $("summary-mode").onchange = (event) => {
    state.style.summaryMode = event.target.value;
    editor.refresh();
  };
  for (const key of Object.keys(defaultMetadata)) {
    $(`meta-${key}`).addEventListener("input", (event) => {
      state.metadata[key] = event.target.value;
      editor.refresh();
    });
  }
  for (const [id, key, output] of [
    ["overlay-height", "height", "height-value"],
    ["overlay-opacity", "opacity", "opacity-value"],
  ]) {
    $(id).oninput = (event) => {
      state.style[key] = Number(event.target.value);
      $(output).textContent = `${event.target.value}%`;
      editor.refresh();
    };
  }
  for (const name of ["theme", "trace"]) {
    document.querySelectorAll(`[data-${name}]`).forEach((button) => {
      button.onclick = () => {
        state.style[name] = button.dataset[name];
        document.querySelectorAll(`[data-${name}]`).forEach((other) => {
          const selected = other === button;
          other.classList.toggle("selected", selected);
          other.setAttribute("aria-pressed", String(selected));
        });
        editor.refresh();
      };
    });
  }
  for (const [id, key] of [
    ["show-pressure", "showPressure"],
    ["show-impulse", "showImpulse"],
  ]) {
    $(id).onchange = (event) => {
      state.style[key] = event.target.checked;
      editor.refresh();
    };
  }
  for (const [id, key] of [
    ["thrust-unit", "thrustUnit"],
    ["pressure-unit", "pressureUnit"],
  ]) {
    $(id).onchange = (event) => {
      state.style[key] = event.target.value;
      editor.refresh();
    };
  }
}
