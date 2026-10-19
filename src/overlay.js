import { clamp, sampleAt, dataTimeAt, formatValue } from "./data.js";
import { displayThrust, displayPressure, DEFAULT_DISPLAY_UNITS } from "./units.js";
import { presentationScale, telemetryHeight, stackedTelemetryGeometry } from "./composition-layout.js";
import { overlayTimeDomain } from "./chart-domain.js";
export { overlayTimeDomain } from "./chart-domain.js";
import { textLines } from "./canvas-text.js";
import { DEFAULT_VIDEO_FRAMING } from "./video-framing.js";

export const defaultStyle = {
  title: "STATIC FIRE TEST",
  ...DEFAULT_DISPLAY_UNITS,
  theme: "dark",
  height: 25,
  opacity: 78,
  trace: "full",
  chartRange: "burn",
  showPressure: true,
  showImpulse: false,
  layout: "full",
  frameAspect: "landscape",
  showDetails: true,
  summaryMode: "live",
  ...DEFAULT_VIDEO_FRAMING,
};

export const defaultMetadata = {
  motor: "",
  testDate: "",
  testId: "",
  location: "",
  logger: "",
  sampleRate: "",
  camera: "",
  notes: "",
};

// Limit the virtual scale by height as well as width so ultrawide recordings
// retain a positive plotting area and legible graphics at the minimum setting.
export function overlayHeight(w, h, style) {
  return telemetryHeight(w, h, style);
}

// Preview and export share these bounds; the chart and instantaneous values
// always occupy separate regions regardless of source or metadata density.
export function overlayGeometry(w, h, style) {
  if (style.layout === "stacked") return stackedTelemetryGeometry(w, h, style);
  const scale = presentationScale(w, h);
  const width = w / scale;
  const height = h / scale;
  const panelHeight = overlayHeight(w, h, style) / scale;
  const top = height - panelHeight;
  const metricsWidth = width * 0.25 - 12;
  const divider = width - metricsWidth - 12;
  const chartRight = divider - 28;
  const chart = {
    x: 82,
    y: top + 62,
    width: chartRight - 82,
    height: panelHeight - 152,
  };
  const horizontal = style.showPressure && chart.height < 200 && chart.width >= 900;
  const gap = horizontal ? 88 : 28;
  const plotHeight = horizontal ? chart.height : (chart.height - gap) / 2;
  const plotWidth = horizontal ? (chart.width - gap) / 2 : chart.width;
  const plots = {
    thrust: { ...chart, width: style.showPressure ? plotWidth : chart.width,
      height: style.showPressure ? plotHeight : chart.height },
    pressure: style.showPressure
      ? { ...chart, x: horizontal ? chart.x + plotWidth + gap : chart.x,
          y: horizontal ? chart.y : chart.y + plotHeight + gap,
          width: plotWidth, height: plotHeight }
      : null,
  };
  return {
    scale,
    width,
    height,
    panelHeight,
    top,
    chart,
    plots,
    orientation: style.showPressure ? horizontal ? "horizontal" : "vertical" : "single",
    footer: { x: 0, y: height - 64, width, height: 64 },
    metrics: {
      x: divider + 26,
      y: top + 60,
      width: metricsWidth - 36,
      rowHeight: 66,
      compactY: height - 80,
      divider,
    },
  };
}

// Rounded display-unit bounds produce useful axis labels without changing any
// sensor values. Negative readings retain their own visible baseline.
export function chartAxis(minimum, maximum) {
  const low = Math.min(0, minimum);
  const high = Math.max(0, maximum);
  const span = high - low || 1;
  const rough = (span * 1.06) / 2;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].find((value) => value * magnitude >= rough) * magnitude;
  const min = Math.floor(low / step) * step;
  const max = Math.max(min + step, Math.ceil(high * 1.06 / step) * step);
  const ticks = Array.from(
    { length: Math.round((max - min) / step) + 1 },
    (_, index) => min + step * index,
  );
  return { min, max, ticks };
}

function axisLabel(value) {
  const magnitude = Math.abs(value);
  if (magnitude >= 10000) return `${Number((value / 1000).toPrecision(3))}k`;
  if (magnitude > 0 && magnitude < 0.001) return value.toExponential(1);
  return String(Number(value.toPrecision(4)));
}

function text(
  ctx,
  content,
  x,
  y,
  size,
  color,
  weight = 400,
  align = "left",
  maxWidth,
) {
  ctx.font = `${weight} ${size}px system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  const label = maxWidth === undefined ? content : textLines(ctx, content, maxWidth, 1)[0] || "";
  if (ctx.shadowBlur > 0) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(3,8,12,.9)";
    ctx.strokeText(label, x, y);
    ctx.restore();
  }
  ctx.fillText(label, x, y);
}

function sensorAxis(data, theory, key, unit) {
  const convert = key === "thrust" ? displayThrust : displayPressure;
  const minimum = key === "thrust" ? "minThrust" : "minPressure";
  const maximum = key === "thrust" ? "peakThrust" : "peakPressure";
  return chartAxis(
    convert(Math.min(data?.[minimum] ?? 0, theory?.data?.[minimum] ?? 0), unit),
    convert(Math.max(data?.[maximum] ?? 0, theory?.data?.[maximum] ?? 0), unit),
  );
}

function drawBurnMarkers(ctx, box, startX, endX, light, contrast) {
  const color = light ? "#285ea8" : "#b2ccf5";
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  ctx.fillStyle = light ? "#285ea80a" : "#9bbff50a";
  ctx.fillRect(startX, box.y, endX - startX, box.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  for (const position of [startX, endX]) {
    ctx.beginPath();
    ctx.moveTo(position, box.y);
    ctx.lineTo(position, box.y + box.height);
    if (contrast) {
      ctx.strokeStyle = "#071018";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  let startLabelX = clamp(startX + 9, box.x + 9, box.x + box.width - 9);
  let endLabelX = clamp(endX - 9, box.x + 9, box.x + box.width - 9);
  if (endLabelX - startLabelX < 20) {
    const center = clamp((startX + endX) / 2, box.x + 20, box.x + box.width - 20);
    startLabelX = center - 11;
    endLabelX = center + 11;
  }
  for (const [label, x] of [["A", startLabelX], ["B", endLabelX]]) {
    ctx.fillStyle = light ? "#f6f8faed" : "#101820ed";
    ctx.fillRect(x - 8, box.y + 1, 16, 17);
    text(ctx, label, x, box.y + 14, 13, color, 650, "center");
  }
  ctx.restore();
}

function drawSignalPlots(ctx, geometry, data, reduced, t, sample, style, measurement, theory) {
  const { chart, plots } = geometry;
  const stacked = style.layout === "stacked";
  const light = style.layout !== "stacked" && style.theme === "light";
  const fg = light ? "#24313c" : "#edf3f7";
  const muted = light ? "#5e6c79" : "#a6b5c2";
  const grid = light ? "rgba(34,50,67,.10)" : style.layout === "stacked"
    ? "rgba(219,229,242,.18)" : "rgba(219,229,242,.11)";
  const thrustColor = light ? "#ad4f29" : "#e9a56c";
  const pressureColor = light ? "#177f85" : "#69c9c7";
  const theoryColor = light ? "#87620a" : "#f3d05c";
  const background = light ? "#f6f8fa" : "#101820";
  const validMeasurement = data && measurement &&
    Number.isFinite(measurement.start) && Number.isFinite(measurement.end) &&
    measurement.end > measurement.start;
  const domain = overlayTimeDomain(data, theory, measurement, style.chartRange);
  const x = (time, box) => box.x + ((time - domain.start) / domain.duration) * box.width;
  const keys = style.showPressure ? ["thrust", "pressure"] : ["thrust"];
  const convert = (value, key) => key === "thrust"
    ? displayThrust(value, style.thrustUnit)
    : displayPressure(value, style.pressureUnit);
  const axes = {
    thrust: sensorAxis(data, theory, "thrust", style.thrustUnit),
    pressure: sensorAxis(data, theory, "pressure", style.pressureUnit),
  };
  const y = (value, key) => {
    const box = plots[key];
    const axis = axes[key];
    return box.y + box.height -
      ((convert(value, key) - axis.min) / (axis.max - axis.min)) * box.height;
  };
  const colors = { thrust: thrustColor, pressure: pressureColor };
  for (const key of keys) {
    const box = plots[key];
    const axis = axes[key];
    const color = colors[key];
    const unit = key === "thrust" ? style.thrustUnit : style.pressureUnit;
    const ticks = box.height < 75 ? [axis.min, axis.max] : axis.ticks;
    ctx.lineWidth = 1;
    for (const tick of ticks) {
      const gy = box.y + box.height -
        ((tick - axis.min) / (axis.max - axis.min)) * box.height;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(box.x, gy);
      ctx.lineTo(box.x + box.width, gy);
      if (stacked) {
        ctx.strokeStyle = "rgba(3,8,12,.55)";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.strokeStyle = "rgba(219,229,242,.35)";
        ctx.lineWidth = 1;
      }
      ctx.stroke();
      text(ctx, data || theory?.data ? axisLabel(tick) : "—", box.x - 10,
        gy + 4, 15, color, 400, "right");
    }
    text(ctx, `${key === "thrust" ? "Thrust" : "Pressure"} · ${unit}`,
      box.x, box.y - (style.layout === "stacked" ? 14 : 10), 16, color, 600,
      "left", style.layout === "stacked" ? box.width * 0.55 : box.width);
    if (style.layout === "stacked")
      text(ctx, `${formatValue(sample ? convert(sample[key], key) : null)} ${unit}`,
        box.x + box.width, box.y - 14, 24, color, 650, "right", box.width * 0.43);
  }

  if (theory?.data && style.layout !== "stacked") {
    const legendY = plots.thrust.y - 10;
    const right = chart.x + chart.width;
    text(ctx, "Measured", right - 125, legendY, 14, muted, 500, "right");
    text(ctx, "Theory", right, legendY, 14, theoryColor, 600, "right");
    ctx.strokeStyle = theoryColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(right - 79, legendY - 4);
    ctx.lineTo(right - 52, legendY - 4);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const timeAxes = geometry.orientation === "horizontal" || style.layout === "stacked"
    ? [plots.thrust, plots.pressure]
    : [style.showPressure ? plots.pressure : plots.thrust];
  for (const box of timeAxes.filter(Boolean)) {
    const bottom = box.y + box.height;
    text(ctx, "CSV time", box.x - 12, bottom + 22, 12, muted, 500, "right");
    for (let i = 0; i <= 4; i++)
      text(ctx, data || theory?.data
        ? `${Number((domain.start + (domain.duration * i) / 4).toFixed(domain.duration < 1 ? 3 : 2))} s`
        : "", box.x + (box.width * i) / 4, bottom + 22,
        14, muted, 400, i === 0 ? "left" : i === 4 ? "right" : "center");
  }

  const path = (key, points, mapping, color, alpha, until, dashed = false) => {
    const box = plots[key];
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y - 2, box.width, box.height + 4);
    ctx.clip();
    if (until !== Infinity) {
      ctx.beginPath();
      ctx.rect(box.x, box.y - 2, clamp(x(until, box) - box.x, 0, box.width), box.height + 4);
      ctx.clip();
    }
    ctx.globalAlpha = alpha;
    const lineWidth = dashed ? 2 : 2.4;
    ctx.lineJoin = "round";
    ctx.setLineDash(dashed ? [6, 3] : []);
    ctx.beginPath();
    points.forEach((point, i) => {
      const px = x(mapping.offset + point.t * mapping.scale, box);
      const py = y(point[key], key);
      if (!i || point.gapBefore) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    if (stacked) {
      ctx.strokeStyle = "#071018";
      ctx.lineWidth = lineWidth + 3;
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    ctx.restore();
  };
  for (const key of keys) {
    const box = plots[key];
    if (!data && !theory?.data) {
      if (!stacked) {
        ctx.fillStyle = background;
        ctx.fillRect(box.x, box.y, box.width, box.height);
      }
      text(ctx, "Waiting for CSV data", box.x + box.width / 2,
        box.y + box.height / 2 + 6, 16, muted, 500, "center");
    }
    if (data && style.trace === "full")
      path(key, reduced, { offset: 0, scale: 1 }, colors[key], stacked ? 0.65 : 0.3, Infinity);
    if (theory?.data)
      path(key, theory.reduced, { offset: theory.offset, scale: theory.timeScale },
        theoryColor, 0.95, Infinity, true);
    if (data)
      path(key, reduced, { offset: 0, scale: 1 }, colors[key], 1, t);
    if (validMeasurement && measurement.visible !== false)
      drawBurnMarkers(ctx, box, x(measurement.start, box), x(measurement.end, box), light, stacked);
    if (data && t >= domain.start && t <= domain.end) {
      ctx.strokeStyle = fg;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(x(t, box), box.y);
      ctx.lineTo(x(t, box), box.y + box.height);
      if (stacked) {
        ctx.strokeStyle = "#071018";
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = fg;
        ctx.lineWidth = 1;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (sample) {
        ctx.fillStyle = colors[key];
        ctx.beginPath();
        ctx.arc(x(t, box), y(sample[key], key), 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = background;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
}

export function drawOverlay(
  ctx,
  w,
  h,
  data,
  reduced,
  videoTime,
  offset,
  timeScale,
  style,
  measurement = null,
  theory = null,
) {
  ctx.save();
  const geometry = overlayGeometry(w, h, style);
  const { scale, width, height, panelHeight, top, metrics } = geometry;
  ctx.scale(scale, scale);
  ctx.beginPath();
  const stacked = style.layout === "stacked";
  if (stacked) {
    ctx.shadowColor = "rgba(0,0,0,.8)";
    ctx.shadowBlur = 3;
  }
  const panel = stacked ? geometry.panel : { x: 0, y: top, width, height: panelHeight };
  ctx.rect(panel.x, panel.y, panel.width, panel.height);
  ctx.clip();
  const light = !stacked && style.theme === "light";
  const fg = light ? "#24313c" : "#edf3f7";
  const muted = light ? "#5e6c79" : "#a6b5c2";
  const grid = light ? "rgba(34,50,67,.10)" : "rgba(219,229,242,.11)";
  const thrustColor = light ? "#ad4f29" : "#e9a56c";
  const pressureColor = light ? "#177f85" : "#69c9c7";
  const theoryColor = light ? "#87620a" : "#f3d05c";
  const opacity = (stacked ? clamp(style.opacity, 0, 95) : style.opacity) / 100;
  ctx.fillStyle = light
    ? `rgba(246,248,250,${opacity})`
    : stacked ? `rgba(10,18,25,${opacity})` : `rgba(16,24,32,${opacity})`;
  ctx.fillRect(panel.x, panel.y, panel.width, panel.height);
  ctx.fillStyle = thrustColor;
  ctx.fillRect(panel.x, panel.y, panel.width, 2);
  const t = dataTimeAt(videoTime, offset, timeScale);
  const sample = sampleAt(data, t);
  const phase = !data
    ? "AWAITING CSV"
    : t < data.start
      ? "AWAITING DATA"
      : t > data.end
        ? "TEST COMPLETE"
        : sample
          ? "TELEMETRY"
          : "DATA GAP";
  const status =
    Math.abs(timeScale - 1) > 1e-8
      ? `TIME STRETCH ${Number((timeScale * 100).toFixed(3))}% · ${phase}`
      : phase;
  const validMeasurement = data && measurement &&
    Number.isFinite(measurement.start) && Number.isFinite(measurement.end) &&
    measurement.end > measurement.start;
  const visibleMeasurement = validMeasurement && measurement.visible !== false;
  if (stacked) {
    const x = panel.x + 22;
    const contentWidth = panel.width - 44;
    text(ctx, style.title, x, top + 31, 19, fg, 650, "left", contentWidth);
    text(ctx, status, x, top + 57, 14, muted, 500, "left", contentWidth);
    if (visibleMeasurement)
      text(ctx, `Burn duration ${(measurement.end - measurement.start).toFixed(3)} s · CSV`,
        x, top + 88, 18, fg, 600, "left", contentWidth);
    if (theory?.data) {
      text(ctx, "Measured", x, top + 116, 15, muted, 500);
      text(ctx, "Theory", x + 142, top + 116, 15, theoryColor, 600);
      ctx.strokeStyle = theoryColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(x + 104, top + 111);
      ctx.lineTo(x + 130, top + 111);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (style.showImpulse) {
      const impulse = data && (sample || t < data.start || t > data.end)
        ? displayThrust(t > data.end ? data.impulse : t < data.start ? 0 : sample.impulse, style.thrustUnit)
        : null;
      text(ctx, "IMPULSE", x, top + panelHeight - 20, 14, muted, 600);
      text(ctx, `${formatValue(impulse)} ${style.thrustUnit}·s`, panel.x + panel.width - 22,
        top + panelHeight - 20, 20, fg, 600, "right", contentWidth * 0.65);
    }
  } else {
    const statusLimit = width * (visibleMeasurement ? 0.34 : 0.48);
    text(ctx, status, width - 26, top + 28, 15, muted, 500, "right", statusLimit);
    text(
      ctx,
      style.title.slice(0, 46),
      26,
      top + 28,
      19,
      fg,
      650,
      "left",
      width * (visibleMeasurement ? 0.3 : 0.45) - 26,
    );
    if (visibleMeasurement)
      text(
        ctx,
        `Burn duration ${(measurement.end - measurement.start).toFixed(3)} s · CSV`,
        width * 0.48,
        top + 28,
        16,
        fg,
        600,
        "center",
        width * 0.3,
      );
  }
  drawSignalPlots(ctx, geometry, data, reduced, t, sample, style, measurement, theory);
  if (style.layout === "stacked") {
    ctx.restore();
    return;
  }
  const mx = metrics.x;
  ctx.strokeStyle = grid;
  ctx.beginPath();
  ctx.moveTo(metrics.divider, top + 50);
  ctx.lineTo(metrics.divider, height - 80);
  ctx.stroke();
  let row = 0;
  const metric = (label, value, unit, color = fg) => {
    const my = metrics.y + row++ * metrics.rowHeight;
    const valueY = my + 37;
    text(ctx, label.toUpperCase(), mx, my, 17, muted, 600);
    text(ctx, unit, width - 26, valueY, 18, color, 500, "right");
    const unitWidth = ctx.measureText(unit).width;
    text(ctx, value, mx, valueY, 32, color, 600, "left",
      Math.max(1, metrics.width - unitWidth - 12));
  };
  metric("Thrust", formatValue(sample ? displayThrust(sample.thrust, style.thrustUnit) : null),
    style.thrustUnit, thrustColor);
  if (style.showPressure)
    metric("Pressure", formatValue(sample ? displayPressure(sample.pressure, style.pressureUnit) : null),
      style.pressureUnit, pressureColor);
  if (style.showImpulse) {
    const value = formatValue(data && (sample || t < data.start || t > data.end)
      ? displayThrust(t > data.end ? data.impulse : t < data.start ? 0 : sample.impulse, style.thrustUnit)
      : null);
    text(ctx, "IMPULSE", mx, metrics.compactY, 15, muted, 600);
    text(ctx, `${value} ${style.thrustUnit}·s`, width - 26, metrics.compactY,
      18, fg, 500, "right", metrics.width * 0.63);
  }
  ctx.restore();
}

export function drawEmpty(ctx, w, h) {
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, "#202c35");
  gradient.addColorStop(1, "#101a21");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(184,205,217,.045)";
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 48) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}
