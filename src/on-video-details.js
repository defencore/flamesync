import { cumulativeAt, dataTimeAt, formatValue, logPositionAt, clamp } from "./data.js";
import { displayThrust, displayPressure } from "./units.js";
import { frameInfoAt } from "./timing.js";
import { textLines, filenameLabel } from "./canvas-text.js";
import { stackedTelemetryGeometry } from "./composition-layout.js";

const foreground = "#edf3f7";
const muted = "#b8c6d1";
const thrust = "#e9a56c";
const pressure = "#69c9c7";

function text(ctx, value, x, y, width, size = 17, color = foreground, weight = 500, align = "left") {
  ctx.font = `${weight} ${size}px system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(textLines(ctx, value, width, 1)[0] || "", x, y);
}

function card(ctx, x, y, width, height, opacity) {
  ctx.fillStyle = `rgba(10,18,25,${opacity})`;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = "rgba(223,234,244,.2)";
  ctx.fillRect(x, y, 2, height);
}

// Metadata and source clocks sit over the footage. File identities have their
// own reserved strip, so long names never cover the test or shrink the image.
export function drawOnVideoDetails(
  ctx, width, height, metadata, source, data, videoTime, offset, timeScale, style,
) {
  const { scale, cards } = stackedTelemetryGeometry(width, height, style);
  const x = cards.x;
  const contentX = x + 18;
  const contentWidth = cards.width - 36;
  const opacity = clamp(style.opacity, 70, 95) / 100;
  ctx.save();
  ctx.scale(scale, scale);
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

  const csvTime = dataTimeAt(videoTime, offset, timeScale);
  const totals = data && style.showDetails
    ? cumulativeAt(data, style.summaryMode === "final" ? data.end : csvTime)
    : null;
  const rows = totals ? [
    ["PEAK THRUST", `${formatValue(displayThrust(totals.peakThrust, style.thrustUnit))} ${style.thrustUnit}`, thrust],
    style.showPressure ? ["PEAK PRESSURE", `${formatValue(displayPressure(totals.peakPressure, style.pressureUnit))} ${style.pressureUnit}`, pressure] : null,
    ["TOTAL IMPULSE", `${formatValue(displayThrust(totals.impulse, style.thrustUnit))} ${style.thrustUnit}·s`, thrust],
  ].filter(Boolean) : [];
  const totalHeight = totals ? 32 + rows.length * 30 : 0;
  const bottomHeight = 118 + totalHeight;
  const top = cards.bottom - bottomHeight;
  card(ctx, x, top, cards.width, bottomHeight, opacity);
  let y = top + 23;
  if (totals) {
    const label = totals.phase === "complete" ? "FINAL RESULTS"
      : totals.phase === "pending" ? "AWAITING DATA"
        : totals.phase === "gap" ? "LIVE TOTALS · DATA GAP" : "LIVE TOTALS";
    text(ctx, label, contentX, y, contentWidth, 14, muted, 650);
    y += 30;
    for (const [label, value, color] of rows) {
      text(ctx, label, contentX, y, contentWidth * 0.46, 13, muted, 600);
      text(ctx, value, contentX + contentWidth, y, contentWidth * 0.52, 22, color, 650, "right");
      y += 30;
    }
    ctx.fillStyle = "rgba(223,234,244,.2)";
    ctx.fillRect(contentX, y - 15, contentWidth, 1);
  }
  const frame = source?.timestamps ? frameInfoAt(source.timestamps, videoTime, source.end) : null;
  const fps = source?.fps > 0 ? `${Number(source.fps.toFixed(2))} fps` : "";
  const log = logPositionAt(data, csvTime);
  const logLine = log?.first
    ? `CSV row ${log.first.line}${log.second ? ` → ${log.second.line}` : ""}${log.phase === "gap" ? " · GAP" : ""}`
    : `CSV row —${log?.phase === "before" ? " · awaiting data" : log?.phase === "after" ? " · complete" : ""}`;
  const rate = data?.duration > 0 ? `${((data.points.length - 1) / data.duration).toFixed(1)} Hz` : "";
  text(ctx, frame ? `Frame ${String(frame.number).padStart(6, "0")} / ${source.timestamps.length.toLocaleString("en-US")}` : "Frame —",
    contentX, y, contentWidth, 18, foreground, 650);
  y += 23;
  text(ctx, frame ? `${frame.timestamp.toFixed(6)} s · ${fps} · ${source.width} × ${source.height}` : "",
    contentX, y, contentWidth, 15, muted);
  y += 29;
  text(ctx, logLine, contentX, y, contentWidth, 18, foreground, 650);
  y += 23;
  text(ctx, data ? `CSV ${csvTime.toFixed(6)} s${rate ? ` · ${rate}` : ""}` : "",
    contentX, y, contentWidth, 15, muted);
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
