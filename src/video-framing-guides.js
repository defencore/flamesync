import { stackedTelemetryGeometry } from "./composition-layout.js";

const namespace = "http://www.w3.org/2000/svg";

export function framingGuideGeometry(width, height, style) {
  const { body, cards, panel, scale } = stackedTelemetryGeometry(width, height, style);
  const left = style.showDetails ? cards.x + cards.width : body.x;
  return {
    body: Object.fromEntries(Object.entries(body).map(([key, value]) => [key, value * scale])),
    panelCenter: ((left + panel.x) / 2) * scale,
  };
}

// A separate SVG follows the canvas's contain-fit scaling, including fullscreen.
// These editing guides never enter the composition canvas or export settings.
export function createVideoFramingGuides(canvas, stage) {
  const svg = document.createElementNS(namespace, "svg");
  svg.id = "video-framing-guides";
  svg.classList.add("framing-guides");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("hidden", "");
  const shadows = document.createElementNS(namespace, "g");
  shadows.classList.add("framing-guide-shadows");
  const grid = document.createElementNS(namespace, "g");
  grid.classList.add("framing-guide-lines");
  const definitions = document.createElementNS(namespace, "defs");
  const clip = document.createElementNS(namespace, "clipPath");
  clip.id = "video-framing-guides-clip";
  clip.setAttribute("clipPathUnits", "userSpaceOnUse");
  const clipRect = document.createElementNS(namespace, "rect");
  clip.append(clipRect);
  definitions.append(clip);
  for (const group of [shadows, grid]) group.setAttribute("clip-path", `url(#${clip.id})`);
  const lines = [];
  function addLine(kind, axis, fraction = 0) {
    const line = document.createElementNS(namespace, "line");
    line.setAttribute("data-guide", kind);
    line.classList.add(`framing-guide-${kind}`);
    line.setAttribute("vector-effect", "non-scaling-stroke");
    const shadow = line.cloneNode();
    shadow.removeAttribute("data-guide");
    shadows.append(shadow);
    grid.append(line);
    lines.push({ line, shadow, kind, axis, fraction });
  }
  for (const axis of ["x", "y"]) for (let step = 1; step < 10; step++)
    addLine(step === 5 ? `center-${axis}` : axis === "y" && step === 8 ? "base" : "grid", axis, step / 10);
  addLine("panel-center", "x");
  svg.append(definitions, shadows, grid);
  stage.append(svg);
  let geometryKey = "";

  return {
    update(visible, geometry) {
      svg.toggleAttribute("hidden", !visible);
      if (!visible) return;
      const { body, panelCenter } = geometry;
      const key = [canvas.width, canvas.height, body.x, body.y, body.width, body.height, panelCenter].join("/");
      if (key === geometryKey) return;
      geometryKey = key;
      svg.setAttribute("viewBox", `0 0 ${canvas.width} ${canvas.height}`);
      for (const [attribute, value] of Object.entries(body)) clipRect.setAttribute(attribute, String(value));
      for (const { line, shadow, kind, axis, fraction } of lines) {
        const x = kind === "panel-center" ? panelCenter : body.x + body.width * fraction;
        const y = body.y + body.height * fraction;
        const coordinates = axis === "x"
          ? { x1: x, x2: x, y1: body.y, y2: body.y + body.height }
          : { x1: body.x, x2: body.x + body.width, y1: y, y2: y };
        for (const [attribute, value] of Object.entries(coordinates)) {
          line.setAttribute(attribute, String(value));
          shadow.setAttribute(attribute, String(value));
        }
      }
    },
    dispose() { svg.remove(); },
  };
}
