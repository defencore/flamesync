import { clamp, sampleAt, dataTimeAt, formatValue } from "./data.js";
import { drawIntervalMarkers } from "./measurement-chart.js";
import { displayThrust, displayPressure } from "./units.js";
import { presentationScale, telemetryHeight } from "./composition-layout.js";
import { textLines } from "./canvas-text.js";

export const defaultStyle = {
  title: "STATIC FIRE TEST",
  thrustUnit: "N",
  pressureUnit: "bar",
  theme: "dark",
  height: 25,
  opacity: 90,
  trace: "full",
  showPressure: true,
  showImpulse: false,
  layout: "full",
  frameAspect: "landscape",
  showDetails: true,
  summaryMode: "live",
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
  const scale = presentationScale(w, h);
  const width = w / scale;
  const height = h / scale;
  const panelHeight = overlayHeight(w, h, style) / scale;
  const top = height - panelHeight;
  const metricsWidth = width * 0.25 - 12;
  const divider = width - metricsWidth - 12;
  const chartRight = divider - 72;
  const chart = {
    x: 82,
    y: top + 67,
    width: chartRight - 82,
    height: panelHeight - 161,
  };
  return {
    scale,
    width,
    height,
    panelHeight,
    top,
    chart,
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
  ctx.fillText(maxWidth === undefined ? content : textLines(ctx, content, maxWidth, 1)[0] || "", x, y);
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
) {
  ctx.save();
  const geometry = overlayGeometry(w, h, style);
  const { scale, width, height, panelHeight, top, chart, metrics } = geometry;
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.rect(0, top, width, panelHeight);
  ctx.clip();
  const light = style.theme === "light";
  const fg = light ? "#24313c" : "#edf3f7";
  const muted = light ? "#5e6c79" : "#a6b5c2";
  const grid = light ? "rgba(34,50,67,.10)" : "rgba(219,229,242,.11)";
  const thrustColor = light ? "#ad4f29" : "#e9a56c";
  const pressureColor = light ? "#177f85" : "#69c9c7";
  ctx.fillStyle = light
    ? `rgba(246,248,250,${style.opacity / 100})`
    : `rgba(16,24,32,${style.opacity / 100})`;
  ctx.fillRect(0, top, width, panelHeight);
  ctx.fillStyle = thrustColor;
  ctx.fillRect(0, top, width, 2);
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
  text(ctx, status, width - 26, top + 29, 16, muted, 500, "right");
  const statusWidth = ctx.measureText(status).width;
  text(
    ctx,
    style.title.slice(0, 46),
    26,
    top + 28,
    20,
    fg,
    650,
    "left",
    Math.max(1, width - statusWidth - 84),
  );
  const chartX = chart.x;
  const chartRight = chart.x + chart.width;
  const chartY = chart.y;
  const chartBottom = chart.y + chart.height;
  const chartW = chart.width;
  const chartH = chart.height;
  const tSpan = data?.duration || 1;
  const x = (time) => chartX + ((time - (data?.start ?? 0)) / tSpan) * chartW;
  const thrustAxis = chartAxis(
    displayThrust(data?.minThrust ?? 0, style.thrustUnit),
    displayThrust(data?.peakThrust ?? 0, style.thrustUnit),
  );
  const pressureAxis = chartAxis(
    displayPressure(data?.minPressure ?? 0, style.pressureUnit),
    displayPressure(data?.peakPressure ?? 0, style.pressureUnit),
  );
  const y = (v, key) => {
    const axis = key === "thrust" ? thrustAxis : pressureAxis;
    const value =
      key === "thrust"
        ? displayThrust(v, style.thrustUnit)
        : displayPressure(v, style.pressureUnit);
    return chartBottom - ((value - axis.min) / (axis.max - axis.min)) * chartH;
  };
  ctx.lineWidth = 1;
  for (const tick of thrustAxis.ticks) {
    const gy =
      chartBottom -
      ((tick - thrustAxis.min) / (thrustAxis.max - thrustAxis.min)) * chartH;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(chartX, gy);
    ctx.lineTo(chartRight, gy);
    ctx.stroke();
    text(
      ctx,
      data ? axisLabel(tick) : "—",
      chartX - 10,
      gy + 4,
      17,
      thrustColor,
      400,
      "right",
    );
  }
  if (style.showPressure) {
    for (const tick of pressureAxis.ticks) {
      const gy =
        chartBottom -
        ((tick - pressureAxis.min) / (pressureAxis.max - pressureAxis.min)) * chartH;
      text(
        ctx,
        data ? axisLabel(tick) : "—",
        chartRight + 9,
        gy + 4,
        17,
        pressureColor,
        400,
        "left",
        60,
      );
    }
  }
  text(ctx, `Thrust · ${style.thrustUnit}`, chartX, chartY - 15, 17, thrustColor, 600);
  if (style.showPressure)
    text(
      ctx,
      `Pressure · ${style.pressureUnit}`,
      chartRight,
      chartY - 15,
      17,
      pressureColor,
      600,
      "right",
    );
  for (let i = 0; i <= 4; i++) {
    text(
      ctx,
      data
        ? `${Number((data.start + (data.duration * i) / 4).toFixed(data.duration < 1 ? 3 : 2))} s`
        : "",
      chartX + (chartW * i) / 4,
      chartBottom + 20,
      16,
      muted,
      400,
      "center",
    );
  }
  const path = (key, color, alpha, until) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(chartX, chartY - 2, chartW, chartH + 4);
    ctx.clip();
    if (until !== Infinity) {
      ctx.beginPath();
      ctx.rect(
        chartX,
        chartY - 2,
        clamp(x(until) - chartX, 0, chartW),
        chartH + 4,
      );
      ctx.clip();
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.3;
    ctx.lineJoin = "round";
    ctx.beginPath();
    reduced.forEach((p, i) => {
      const gap = p.gapBefore;
      if (!i || gap) ctx.moveTo(x(p.t), y(p[key], key));
      else ctx.lineTo(x(p.t), y(p[key], key));
    });
    ctx.stroke();
    ctx.restore();
  };
  if (!data) {
    // Empty telemetry uses the same panel geometry as a loaded CSV.
    const center = chartX + chartW / 2;
    const centerY = chartY + chartH / 2;
    ctx.fillStyle = light ? "#f6f8fa" : "#101820";
    ctx.fillRect(chartX, centerY - 25, chartW, 50);
    text(
      ctx,
      "Waiting for CSV data",
      center,
      centerY - 3,
      20,
      fg,
      550,
      "center",
    );
  }
  if (data && style.trace === "full") {
    path("thrust", thrustColor, 0.3, Infinity);
    if (style.showPressure) path("pressure", pressureColor, 0.3, Infinity);
  }
  if (data) path("thrust", thrustColor, 1, t);
  if (data && style.showPressure) path("pressure", pressureColor, 1, t);
  if (data && measurement)
    drawIntervalMarkers(
      ctx,
      { x: chartX, y: chartY, width: chartW, height: chartH },
      x(measurement.start),
      x(measurement.end),
      `Δt ${(measurement.end - measurement.start).toFixed(3)} s · CSV`,
      light,
    );
  if (data && t >= data.start && t <= data.end) {
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(x(t), chartY);
    ctx.lineTo(x(t), chartBottom);
    ctx.stroke();
    ctx.setLineDash([]);
    if (sample) {
      for (const [key, color] of [
        ["thrust", thrustColor],
        ["pressure", pressureColor],
      ]) {
        if (key === "pressure" && !style.showPressure) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x(t), y(sample[key], key), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = light ? "#f6f8fa" : "#101820";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
  const mx = metrics.x;
  ctx.strokeStyle = grid;
  ctx.beginPath();
  ctx.moveTo(metrics.divider, top + 50);
  ctx.lineTo(metrics.divider, height - 80);
  ctx.stroke();
  const rowH = metrics.rowHeight;
  let row = 0;
  const metric = (label, value, unit, color = fg) => {
    const my = metrics.y + row++ * rowH;
    const valueY = my + 37;
    const valueSize = 32;
    text(ctx, label.toUpperCase(), mx, my, 17, muted, 600);
    text(ctx, unit, width - 26, valueY, 18, color, 500, "right");
    const unitWidth = ctx.measureText(unit).width;
    text(
      ctx,
      value,
      mx,
      valueY,
      valueSize,
      color,
      600,
      "left",
      Math.max(1, metrics.width - unitWidth - 12),
    );
  };
  const compactMetric = (label, value, unit, y) => {
    text(ctx, label.toUpperCase(), mx, y, 15, muted, 600);
    text(
      ctx,
      `${value} ${unit}`,
      width - 26,
      y,
      18,
      fg,
      500,
      "right",
      metrics.width * 0.63,
    );
  };

  metric(
    "Thrust",
    formatValue(sample ? displayThrust(sample.thrust, style.thrustUnit) : null),
    style.thrustUnit,
    thrustColor,
  );
  if (style.showPressure)
    metric(
      "Pressure",
      formatValue(
        sample ? displayPressure(sample.pressure, style.pressureUnit) : null,
      ),
      style.pressureUnit,
      pressureColor,
    );
  if (style.showImpulse)
    compactMetric(
      "Impulse",
      formatValue(
        data && (sample || t < data.start || t > data.end)
          ? displayThrust(
              t > data.end ? data.impulse : t < data.start ? 0 : sample.impulse,
              style.thrustUnit,
            )
          : null,
      ),
      `${style.thrustUnit}·s`,
      metrics.compactY,
    );
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
