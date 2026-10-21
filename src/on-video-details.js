import { cumulativeAt, dataTimeAt, formatValue, logPositionAt, clamp } from "./data.js";
import { displayThrust, displayPressure } from "./units.js";
import { frameInfoAt } from "./timing.js";
import { textLines, filenameLabel } from "./canvas-text.js";
import { stackedTelemetryGeometry } from "./composition-layout.js";
import { logRowNumbers, logRateLabel } from "./log-details.js";

const foreground = "#edf3f7";
const muted = "#bdcbd6";
const thrust = "#e9a56c";
const pressure = "#69c9c7";
const family = "system-ui, -apple-system, sans-serif";
const metadataLayouts = new WeakMap();

// Text contrast remains independent of the floating panel's background alpha.
function text(ctx, value, x, y, width, size = 17, color = foreground, weight = 500, align = "left") {
  ctx.save();
  ctx.font = `${weight} ${size}px ${family}`;
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

// Full values wrap naturally. Only a genuinely full card shares its remaining
// lines among fields, so even unusually long notes cannot hide another field.
function recordLayout(ctx, fields, width, height) {
  const labelWidth = Math.min(92, width * 0.29);
  const valueWidth = width - labelWidth - 12;
  let size = 17;
  let lineHeight = 22;
  let gap = 8;
  let rows = [];
  let naturalHeight = 0;
  for (; size >= 15; size--) {
    ctx.font = `500 ${size}px ${family}`;
    lineHeight = size + 5;
    rows = fields.map(([label, value]) => ({
      label,
      value,
      lines: textLines(ctx, value, valueWidth, Infinity),
    }));
    naturalHeight = rows.reduce((sum, row) => sum + row.lines.length * lineHeight, 0)
      + gap * Math.max(0, rows.length - 1);
    if (naturalHeight <= height) break;
  }
  size = Math.max(15, size);
  ctx.font = `500 ${size}px ${family}`;
  lineHeight = size + 5;
  gap = Math.min(gap, Math.max(0,
    (height - fields.length * lineHeight) / Math.max(1, fields.length - 1)));
  const availableLines = Math.max(fields.length,
    Math.floor((height - gap * Math.max(0, fields.length - 1)) / lineHeight));
  const allowances = fields.map(() => 1);
  let remaining = availableLines - fields.length;
  while (remaining > 0) {
    let changed = false;
    rows.forEach((row, index) => {
      if (remaining > 0 && allowances[index] < row.lines.length) {
        allowances[index]++;
        remaining--;
        changed = true;
      }
    });
    if (!changed) break;
  }
  rows = rows.map((row, index) => ({
    label: row.label,
    lines: textLines(ctx, row.value, valueWidth, allowances[index]),
  }));
  return {
    size,
    lineHeight,
    gap,
    labelWidth,
    valueWidth,
    rows,
    height: rows.reduce((sum, row) => sum + row.lines.length * lineHeight, 0)
      + gap * Math.max(0, rows.length - 1),
  };
}

function metadataLayout(ctx, metadata, width, maxHeight) {
  const fields = [
    ["TEST ID", metadata.testId],
    ["LOCATION", metadata.location],
    ["LOGGER", metadata.logger],
    ["LOG RATE", metadata.sampleRate],
    ["CAMERA", metadata.camera],
    ["NOTES", metadata.notes],
  ].filter(([, value]) => value?.trim());
  const key = JSON.stringify([metadata.motor, metadata.testDate, fields, width, maxHeight]);
  const cached = metadataLayouts.get(ctx);
  if (cached?.key === key) return cached.layout;
  ctx.font = `650 29px ${family}`;
  const model = textLines(ctx, metadata.motor?.trim(), width, 2);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(metadata.testDate) ? metadata.testDate : "";
  const identityHeight = model.length * 35 + (date ? 26 : 0);
  const recordY = identityHeight + (identityHeight && fields.length ? 14 : 0);
  const record = recordLayout(ctx, fields, width, Math.max(0, maxHeight - 36 - recordY));
  const height = model.length || date || fields.length ? recordY + record.height + 36 : 0;
  const layout = { model, date, recordY, record, height };
  metadataLayouts.set(ctx, { key, layout });
  return layout;
}

function drawMetadata(ctx, cards, metadata, contentX, contentWidth, maxHeight, opacity) {
  const layout = metadataLayout(ctx, metadata, contentWidth, maxHeight);
  if (!layout.height) return;
  card(ctx, cards.x, cards.top, cards.width, layout.height, opacity);
  let y = cards.top + 18;
  for (const line of layout.model) {
    text(ctx, line, contentX, y + 27, contentWidth, 29, foreground, 650);
    y += 35;
  }
  if (layout.date) text(ctx, layout.date, contentX, y + 18, contentWidth, 17, muted);
  const record = layout.record;
  y = cards.top + 18 + layout.recordY;
  for (const row of record.rows) {
    text(ctx, row.label, contentX, y + record.size,
      record.labelWidth, 13, muted, 650);
    row.lines.forEach((line, index) => text(ctx, line,
      contentX + record.labelWidth + 12,
      y + record.size + index * record.lineHeight,
      record.valueWidth, record.size));
    y += row.lines.length * record.lineHeight + record.gap;
  }
}

function drawLiveTotals(ctx, cards, totals, style, contentX, contentWidth, opacity, height) {
  const rows = [
    ["PEAK THRUST", `${formatValue(displayThrust(totals.peakThrust, style.thrustUnit))} ${style.thrustUnit}`, thrust],
    style.showPressure
      ? ["PEAK PRESSURE", `${formatValue(displayPressure(totals.peakPressure, style.pressureUnit))} ${style.pressureUnit}`, pressure]
      : null,
    ["IMPULSE SO FAR", `${formatValue(displayThrust(totals.impulse, style.thrustUnit))} ${style.thrustUnit}·s`, thrust],
  ].filter(Boolean);
  const top = cards.bottom - height;
  card(ctx, cards.x, top, cards.width, height, opacity);
  const status = totals.phase === "complete" ? "COMPLETE"
    : totals.phase === "pending" ? "WAITING"
      : totals.phase === "gap" ? "DATA GAP" : "ACTIVE";
  text(ctx, "LIVE TOTALS", contentX, top + 24, contentWidth * 0.57, 13, muted, 650);
  text(ctx, status, contentX + contentWidth, top + 24,
    contentWidth * 0.4, 11, totals.phase === "gap" ? thrust : muted, 650, "right");
  ctx.fillStyle = "rgba(202,222,236,.18)";
  ctx.fillRect(contentX, top + 35, contentWidth, 1);
  let y = top + 58;
  for (const [label, value, color] of rows) {
    text(ctx, label, contentX, y, contentWidth, 13, muted, 600);
    text(ctx, value, contentX, y + 27, contentWidth, 24, color, 650);
    y += 54;
  }
}

// Keep both source clocks on one line without repeating category headings.
function drawTechnicalHeader(ctx, header, source, data, videoTime, csvTime) {
  const frame = source?.timestamps ? frameInfoAt(source.timestamps, videoTime, source.end) : null;
  const fps = source?.fps > 0 ? `${Number(source.fps.toFixed(2))} fps` : "FPS unavailable";
  const log = logPositionAt(data, csvTime);
  const frameLabel = frame
    ? `Frame ${String(frame.number).padStart(6, "0")} / ${source.timestamps.length.toLocaleString("en-US")} · ${frame.timestamp.toFixed(6)} s`
    : "Frame —";
  const logLabel = data?.separateTime ? `Log rows ${logRowNumbers(data, csvTime)}` : log?.first
    ? `Log row ${log.first.line}${log.second ? ` → ${log.second.line}` : ""}${log.phase === "gap" ? " · GAP" : ""}`
    : `Log row —${log?.phase === "before" ? " · awaiting data" : log?.phase === "after" ? " · complete" : ""}`;
  const logPosition = data ? `${logLabel} · ${csvTime.toFixed(6)} s` : "No telemetry loaded";
  const format = source?.width && source?.height
    ? `${source.width} × ${source.height} · ${fps}${source.variable ? " · VFR" : ""}`
    : "No video loaded";
  const rate = data ? `${logRateLabel(data)} avg` : "";
  const acquisition = `${format}${rate ? ` · ${rate}` : ""}`;
  const compact = header.height > 42;
  ctx.fillStyle = "#101820";
  ctx.fillRect(header.x, header.y, header.width, header.height);
  ctx.fillStyle = "rgba(202,222,236,.18)";
  ctx.fillRect(header.x, header.y + header.height - 1, header.width, 1);
  const columnWidth = header.width / (compact ? 2 : 3);
  const cells = compact ? [frameLabel, logPosition] : [frameLabel, logPosition, acquisition];
  for (let index = 0; index < cells.length; index++) {
    const x = header.x + 20 + index * columnWidth;
    const width = columnWidth - 40;
    if (index) {
      ctx.fillStyle = "rgba(202,222,236,.15)";
      ctx.fillRect(header.x + index * columnWidth, header.y + 12, 1, 18);
    }
    const technical = index === 2;
    text(ctx, cells[index], technical ? x + width : x, header.y + 27, width,
      technical ? 16 : 18, technical ? muted : foreground, technical ? 500 : 600,
      technical ? "right" : "left");
  }
  if (compact) {
    text(ctx, acquisition, header.x + 20, header.y + 58,
      header.width - 40, 16, muted);
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
    const totals = data ? cumulativeAt(data, csvTime) : null;
    const totalHeight = totals ? 48 + (style.showPressure ? 3 : 2) * 54 : 0;
    const metadataHeight = cards.bottom - cards.top - totalHeight - (totals ? 18 : 0);
    drawMetadata(ctx, cards, metadata, contentX, contentWidth, metadataHeight, opacity);
    if (totals) drawLiveTotals(ctx, cards, totals, style, contentX, contentWidth, opacity, totalHeight);
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
