import { cumulativeAt, dataTimeAt, formatValue } from "./data.js";
import { displayThrust, displayPressure } from "./units.js";
import { presentationScale } from "./composition-layout.js";
import { textLines } from "./canvas-text.js";

const layouts = new WeakMap();
const family = "system-ui, -apple-system, sans-serif";

function recordLayout(ctx, fields, width, height) {
  const labelWidth = Math.min(108, width * 0.27);
  const valueWidth = width - labelWidth - 14;
  const minimumSize = height >= fields.length * 40 ? 16 : 12;
  let size = 18,
    lineHeight,
    rows,
    gap;
  for (; size >= minimumSize; size--) {
    ctx.font = `${size}px ${family}`;
    lineHeight = size * 1.22;
    gap = size >= 16 ? 8 : 4;
    rows = fields.map(([label, value]) => ({
      label,
      lines: textLines(ctx, value, valueWidth, Infinity),
    }));
    if (
      rows.reduce((sum, row) => sum + row.lines.length * lineHeight, 0) +
        gap * Math.max(0, rows.length - 1) <=
      height
    )
      break;
  }
  size = Math.max(minimumSize, size);
  ctx.font = `${size}px ${family}`;
  lineHeight = size * 1.22;
  gap = Math.min(
    gap,
    Math.max(
      0,
      (height - fields.length * lineHeight) / Math.max(1, fields.length - 1),
    ),
  );
  const availableLines = Math.max(
    fields.length,
    Math.floor(
      (height - gap * Math.max(0, fields.length - 1)) / lineHeight,
    ),
  );
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
  return {
    size,
    lineHeight,
    gap,
    labelWidth,
    valueWidth,
    rows: fields.map(([label, value], index) => ({
      label,
      lines: textLines(ctx, value, valueWidth, allowances[index]),
    })),
  };
}

// Wrap complete records once, keeping every populated field. If an explicitly
// chosen compact output cannot fit full values, each field retains a readable
// value with an ellipsis instead of disappearing or resizing the footage.
function detailsLayout(ctx, width, height, metadata, showPressure, hasData) {
  const fields = [
    ["TEST ID", metadata.testId],
    ["LOCATION", metadata.location],
    ["LOGGER", metadata.logger],
    ["LOG RATE", metadata.sampleRate],
    ["CAMERA", metadata.camera],
    ["NOTES", metadata.notes],
  ].filter(([, value]) => value?.trim());
  const key = JSON.stringify([
    width,
    height,
    metadata.motor,
    metadata.testDate,
    fields,
    showPressure,
    hasData,
  ]);
  const cached = layouts.get(ctx);
  if (cached?.key === key) return cached.layout;
  const compact = height < 600;
  const modelSize = compact ? 26 : 32;
  const modelLine = compact ? 31 : 38;
  ctx.font = `650 ${modelSize}px ${family}`;
  const model = textLines(ctx, metadata.motor.trim(), width, 2);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(metadata.testDate)
    ? metadata.testDate
    : "";
  const headerHeight =
    model.length * modelLine +
    (date ? 26 : 0) +
    (model.length || date ? 16 : 0);
  const resultHeight = hasData
    ? (2 + Number(showPressure)) * (compact ? 28 : 36) + 40
    : 0;
  const recordY = headerHeight + resultHeight + 38;
  const record = recordLayout(ctx, fields, width, Math.max(0, height - recordY));
  const layout = {
    compact,
    modelSize,
    modelLine,
    model,
    date,
    headerHeight,
    resultHeight,
    recordY,
    record,
  };
  layouts.set(ctx, { key, layout });
  return layout;
}

export function drawVideoDetails(
  ctx,
  box,
  metadata,
  data,
  style,
  videoTime,
  offset,
  timeScale,
) {
  const scale = presentationScale(ctx.canvas.width, ctx.canvas.height);
  const width = box.width / scale,
    height = box.height / scale;
  const padding = 24;
  const contentWidth = width - padding * 2;
  const light = style.theme === "light";
  const fg = light ? "#283541" : "#eaf1f7";
  const muted = light ? "#63727f" : "#a5b4c1";
  const thrust = light ? "#ad4f29" : "#e9a56c";
  const pressure = light ? "#177f85" : "#69c9c7";
  ctx.save();
  ctx.translate(box.x, box.y);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.fillStyle = light ? "#f0f4f7" : "#16212b";
  ctx.fillRect(0, 0, width, height);
  ctx.translate(padding, padding);
  const layout = detailsLayout(
    ctx,
    contentWidth,
    height - padding * 2,
    metadata,
    style.showPressure,
    !!data,
  );
  const text = (
    value,
    x,
    y,
    size,
    color = fg,
    weight = 500,
    maxWidth = contentWidth - x,
    align = "left",
  ) => {
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(textLines(ctx, value, maxWidth, 1)[0] || "", x, y);
  };
  layout.model.forEach((line, index) =>
    text(
      line,
      0,
      layout.modelSize + index * layout.modelLine,
      layout.modelSize,
      fg,
      650,
    ),
  );
  if (layout.date)
    text(
      layout.date,
      0,
      layout.model.length * layout.modelLine + 22,
      layout.compact ? 17 : 20,
      muted,
    );
  const totals = data
    ? cumulativeAt(
        data,
        style.summaryMode === "final"
          ? data.end
          : dataTimeAt(videoTime, offset, timeScale),
      )
    : null;
  const heading =
    totals?.phase === "complete"
      ? "FINAL RESULTS"
      : totals?.phase === "pending"
        ? "AWAITING DATA"
        : totals?.phase === "gap"
          ? "LIVE TOTALS · DATA GAP"
          : "LIVE TOTALS";
  if (totals) {
    text(heading, 0, layout.headerHeight + 14, 15, muted, 650);
    const stats = [
      [
        "PEAK THRUST",
        `${formatValue(displayThrust(totals.peakThrust, style.thrustUnit))} ${style.thrustUnit}`,
        thrust,
      ],
      style.showPressure
        ? [
            "PEAK PRESSURE",
            `${formatValue(
              displayPressure(totals.peakPressure, style.pressureUnit),
            )} ${style.pressureUnit}`,
            pressure,
          ]
        : null,
      [
        "TOTAL IMPULSE",
        `${formatValue(displayThrust(totals.impulse, style.thrustUnit))} ${style.thrustUnit}·s`,
        thrust,
      ],
    ].filter(Boolean);
    stats.forEach((row, index) => {
      const y =
        layout.headerHeight +
        (layout.compact ? 42 : 50) +
        index * (layout.compact ? 28 : 36);
      text(
        row[0],
        0,
        y,
        layout.compact ? 13 : 16,
        muted,
        600,
        contentWidth * 0.46,
      );
      text(
        row[1],
        contentWidth,
        y + 1,
        layout.compact ? 21 : 25,
        row[2],
        600,
        contentWidth * 0.52,
        "right",
      );
    });
  }
  if (layout.record.rows.length) {
    text("TEST RECORD", 0, layout.recordY - 18, 15, muted, 650);
    const record = layout.record;
    let y = layout.recordY + record.size;
    for (const row of record.rows) {
      text(
        row.label,
        0,
        y,
        Math.max(11, record.size - 3),
        muted,
        650,
        record.labelWidth,
      );
      row.lines.forEach((line, index) =>
        text(
          line,
          record.labelWidth + 14,
          y + index * record.lineHeight,
          record.size,
          fg,
          400,
          record.valueWidth,
        ),
      );
      y += row.lines.length * record.lineHeight + record.gap;
    }
  }
  ctx.restore();
}
