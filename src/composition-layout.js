import { clamp, containRect } from "./data.js";

export function presentationScale(width, height) {
  return Math.min(width / (height > width ? 1080 : 1920), height / 900);
}

// Optional curves, values, and metadata never resize the footage area.
export function telemetryHeight(width, height, style) {
  const scale = presentationScale(width, height);
  return clamp((height * style.height) / 100, 270 * scale, height * 0.55);
}

// The on-video template has one fixed filename strip. Optional data never
// takes space away from the fitted source image.
export function stackedTelemetryGeometry(width, height, style) {
  const scale = presentationScale(width, height);
  const w = width / scale;
  const h = height / scale;
  const footerHeight = 42;
  const panelWidth = w < 1400 ? w * 0.52 : Math.min(660, w * 0.34);
  const panel = {
    x: w - panelWidth - 24,
    y: 24,
    width: panelWidth,
    height: h - footerHeight - 48,
  };
  const chart = {
    x: panel.x + 76,
    y: panel.y + 178,
    width: panel.width - 100,
    height: panel.height - 254,
  };
  const gap = 82;
  const plotHeight = style.showPressure ? (chart.height - gap) / 2 : chart.height;
  return {
    scale,
    width: w,
    height: h,
    panel,
    panelHeight: panel.height,
    top: panel.y,
    chart,
    plots: {
      thrust: { ...chart, height: plotHeight },
      pressure: style.showPressure
        ? { ...chart, y: chart.y + plotHeight + gap, height: plotHeight }
        : null,
    },
    orientation: style.showPressure ? "vertical" : "single",
    footer: { x: 0, y: h - footerHeight, width: w, height: footerHeight },
    metrics: null,
    cards: {
      x: 24,
      width: Math.min(580, panel.x - 48),
      top: 24,
      bottom: h - footerHeight - 24,
    },
  };
}

export function compositionGeometry(
  width,
  height,
  sourceWidth,
  sourceHeight,
  style,
) {
  const full = style.layout === "full";
  const stacked = style.layout === "stacked";
  const panelHeight = full ? telemetryHeight(width, height, style) : 0;
  const infoWidth = full ? Math.min(width * 0.25, (height - panelHeight) * 0.84) : 0;
  const videoBox = {
    x: 0,
    y: 0,
    width: width - infoWidth,
    height: height - (stacked ? 42 * presentationScale(width, height) : panelHeight),
  };
  const stripHeight = (stacked ? 42 : 64) * presentationScale(width, height);
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
