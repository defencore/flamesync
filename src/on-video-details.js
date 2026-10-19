import { cumulativeAt, dataTimeAt, formatValue, logPositionAt, clamp } from "./data.js";
import { displayThrust, displayPressure } from "./units.js";
import { frameInfoAt } from "./timing.js";
import { textLines, filenameLabel } from "./canvas-text.js";
import { stackedTelemetryGeometry } from "./composition-layout.js";

const foreground = "#edf3f7";
const muted = "#bdcbd6";
const thrust = "#e9a56c";
const pressure = "#69c9c7";

// Text contrast remains independent of the floating panel's background alpha.
function text(ctx, value, x, y, width, size = 17, color = foreground, weight = 500, align = "left") {
  ctx.save();
  ctx.font = `${weight} ${size}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = align;
  const label = textLines(ctx, value, width, 1)[0] || "";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(3,8,12,.85)";
  ctx.shadowColor = "rgba(0,0,0,.8)";
  ctx.shadowBlur = 3;
  ctx.strokeText(label, x, y);
  ctx.fillStyle = color;
  ctx.fillText(label, x, y);
  ctx.restore();
}

function card(ctx, x, y, width, height, opacity) {
  ctx.fillStyle = `rgba(10,18,25,${opacity})`;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = "rgba(223,234,244,.3)";
  ctx.fillRect(x, y, 2, height);
}

// The original camera PTS and CSV clock remain separate at every playback rate.
function drawTechnicalHeader(ctx, header, source, data, videoTime, csvTime) {
  const frame = source?.timestamps ? frameInfoAt(source.timestamps, videoTime, source.end) : null;
  const fps = source?.fps > 0 ? `${Number(source.fps.toFixed(2))} fps` : "FPS unavailable";
  const log = logPositionAt(data, csvTime);
  const frameLabel = frame
    ? `Frame ${String(frame.number).padStart(6, "0")} / ${source.timestamps.length.toLocaleString("en-US")}`
    : "Frame —";
  const frameClock = frame
    ? `PTS ${frame.timestamp.toFixed(6)} s · Δ ${(frame.duration * 1000).toFixed(3)} ms`
    : "Original camera timestamps";
  const logLabel = log?.first
    ? `CSV row ${log.first.line}${log.second ? ` → ${log.second.line}` : ""}${log.phase === "gap" ? " · GAP" : ""}`
    : `CSV row —${log?.phase === "before" ? " · awaiting data" : log?.phase === "after" ? " · complete" : ""}`;
  const logClock = data ? `CSV ${csvTime.toFixed(6)} s` : "No telemetry loaded";
  const format = source?.width && source?.height
    ? `${source.width} × ${source.height} · ${fps}${source.variable ? " · VFR" : ""}`
    : "No video loaded";
  const rate = data?.duration > 0 ? `${((data.points.length - 1) / data.duration).toFixed(1)} Hz avg` : "";
  const units = data?.sourceUnits;
  const acquisition = data
    ? `CSV ${rate}${units ? ` · ${units.time} / ${units.thrust} / ${units.pressure}` : ""}`
    : "CSV units —";
  const compact = header.height > 68;
  ctx.fillStyle = "#101820";
  ctx.fillRect(header.x, header.y, header.width, header.height);
  ctx.fillStyle = "rgba(202,222,236,.18)";
  ctx.fillRect(0, header.height - 1, header.width, 1);
  const columnWidth = header.width / (compact ? 2 : 3);
  const cells = [
    ["VIDEO FRAME", frameLabel, frameClock],
    ["CSV POSITION", logLabel, logClock],
    ["ACQUISITION", format, acquisition],
  ];
  for (let index = 0; index < (compact ? 2 : 3); index++) {
    const [label, value, detail] = cells[index];
    const x = 20 + index * columnWidth;
    const width = columnWidth - 40;
    if (index) {
      ctx.fillStyle = "rgba(202,222,236,.15)";
      ctx.fillRect(index * columnWidth, 12, 1, 45);
    }
    text(ctx, label, x, 16, width, 11, muted, 650);
    text(ctx, value, x, 38, width, 19, foreground, 650);
    text(ctx, detail, x, 58, width, 14, muted, 500);
  }
  if (compact) {
    ctx.fillStyle = "rgba(202,222,236,.12)";
    ctx.fillRect(20, 68, header.width - 40, 1);
    text(ctx, format, 20, 89, header.width * 0.48 - 20, 14, foreground, 600);
    text(ctx, acquisition, header.width - 20, 89, header.width * 0.5 - 20, 13, muted, 500, "right");
  }
}

// Technical source clocks have their own reserved header. Floating cards hold
// test identity and cumulative results; source filenames stay in the footer.
export function drawOnVideoDetails(
  ctx, width, height, metadata, source, data, videoTime, offset, timeScale, style,
) {
  const { scale, cards, header } = stackedTelemetryGeometry(width, height, style);
  const x = cards.x;
  const contentX = x + 18;
  const contentWidth = cards.width - 36;
  const opacity = clamp(style.opacity, 0, 95) / 100;
  const csvTime = dataTimeAt(videoTime, offset, timeScale);
  ctx.save();
  ctx.scale(scale, scale);
  drawTechnicalHeader(ctx, header, source, data, videoTime, csvTime);
  if (style.showDetails) {
    const fields = [
      ["TEST ID", metadata.testId],
      ["LOCATION", metadata.location],
      ["LOGGER", metadata.logger],
      ["LOG RATE", metadata.sampleRate],
      ["CAMERA", metadata.camera],
      ["NOTES", metadata.notes],
    ].filter(([, value]) => value?.trim());
    ctx.font = "650 30px system-ui, -apple-system, sans-serif";
    const model = textLines(ctx, metadata.motor?.trim(), contentWidth, 2);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(metadata.testDate) ? metadata.testDate : "";
    const headerHeight = model.length * 35 + (date ? 27 : 0);
    if (headerHeight || fields.length) {
      const topHeight = headerHeight + fields.length * 28 + 30;
      card(ctx, x, cards.top, cards.width, topHeight, opacity);
      let y = cards.top + 18;
      for (const line of model) {
        text(ctx, line, contentX, y + 27, contentWidth, 30, foreground, 650);
        y += 35;
      }
      if (date) {
        text(ctx, date, contentX, y + 18, contentWidth, 18, muted);
        y += 27;
      }
      const labelWidth = Math.min(112, contentWidth * 0.31);
      for (const [label, value] of fields) {
        text(ctx, label, contentX, y + 18, labelWidth - 8, 13, muted, 650);
        text(ctx, value, contentX + labelWidth, y + 18, contentWidth - labelWidth, 17);
        y += 28;
      }
    }
  }

  const totals = data && style.showDetails
    ? cumulativeAt(data, style.summaryMode === "final" ? data.end : csvTime)
    : null;
  if (totals) {
    const rows = [
      ["PEAK THRUST", `${formatValue(displayThrust(totals.peakThrust, style.thrustUnit))} ${style.thrustUnit}`, thrust],
      style.showPressure ? ["PEAK PRESSURE", `${formatValue(displayPressure(totals.peakPressure, style.pressureUnit))} ${style.pressureUnit}`, pressure] : null,
      ["TOTAL IMPULSE", `${formatValue(displayThrust(totals.impulse, style.thrustUnit))} ${style.thrustUnit}·s`, thrust],
    ].filter(Boolean);
    const totalHeight = 50 + rows.length * 30;
    const top = cards.bottom - totalHeight;
    card(ctx, x, top, cards.width, totalHeight, opacity);
    let y = top + 24;
    const label = totals.phase === "complete" ? "FINAL RESULTS"
      : totals.phase === "pending" ? "AWAITING DATA"
        : totals.phase === "gap" ? "LIVE TOTALS · DATA GAP" : "LIVE TOTALS";
    text(ctx, label, contentX, y, contentWidth, 13, muted, 650);
    y += 30;
    for (const [label, value, color] of rows) {
      text(ctx, label, contentX, y, contentWidth * 0.46, 13, muted, 600);
      text(ctx, value, contentX + contentWidth, y, contentWidth * 0.52, 22, color, 650, "right");
      y += 30;
    }
  }
  ctx.restore();
}

export function drawOnVideoSources(ctx, width, height, source, theory, style) {
  const { scale, footer } = stackedTelemetryGeometry(width, height, style);
  const sources = [
    ["VIDEO", source?.videoName],
    ["LOG", source?.logName],
    ["THEORY", theory?.name],
  ].filter(([, name]) => name);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = "#101820";
  ctx.fillRect(footer.x, footer.y, footer.width, footer.height);
  const cellWidth = (footer.width - 24) / Math.max(1, sources.length);
  for (let index = 0; index < sources.length; index++) {
    const [label, name] = sources[index];
    const x = 16 + index * cellWidth;
    const labelWidth = label === "THEORY" ? 76 : 68;
    text(ctx, label, x, footer.y + 27, labelWidth, 13, muted, 650);
    ctx.font = "500 17px system-ui, -apple-system, sans-serif";
    const nameWidth = cellWidth - labelWidth - 24;
    text(ctx, filenameLabel(ctx, name, nameWidth), x + labelWidth,
      footer.y + 27, nameWidth, 17);
  }
  ctx.restore();
}
