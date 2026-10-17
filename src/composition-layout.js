import { clamp, containRect } from "./data.js";

export function presentationScale(width, height) {
  return Math.min(width / (height > width ? 1080 : 1920), height / 900);
}

// Optional curves, values, and metadata never resize the footage area.
export function telemetryHeight(width, height, style) {
  const scale = presentationScale(width, height);
  return clamp((height * style.height) / 100, 270 * scale, height * 0.55);
}

export function compositionGeometry(
  width,
  height,
  sourceWidth,
  sourceHeight,
  style,
) {
  const full = style.layout === "full";
  const panelHeight = full ? telemetryHeight(width, height, style) : 0;
  const infoWidth = full ? Math.min(width * 0.25, (height - panelHeight) * 0.84) : 0;
  const videoBox = {
    x: 0,
    y: 0,
    width: width - infoWidth,
    height: height - panelHeight,
  };
  const stripHeight = 64 * presentationScale(width, height);
  return {
    video: containRect(sourceWidth, sourceHeight, videoBox),
    info: full
      ? {
          x: width - infoWidth,
          y: 0,
          width: infoWidth,
          height: videoBox.height,
        }
      : null,
    sources: { x: 0, y: height - stripHeight, width, height: stripHeight },
    panelHeight,
  };
}
