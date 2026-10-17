import {
  containRect,
  formatValue,
  cumulativeAt,
  dataTimeAt,
  logPositionAt,
} from "./data.js";
import { displayThrust, displayPressure } from "./units.js";
import { drawOverlay, drawEmpty, overlayHeight } from "./overlay.js";
import { frameInfoAt } from "./timing.js";

// Full-frame presentation fits the entire source inside a reserved video region.
// It never crops the source, stretches its aspect ratio, or draws telemetry on it.
export function compositionGeometry(w, h, sourceWidth, sourceHeight, style) {
  // Importing either source must not change the reserved telemetry region.
  const panelHeight = style.layout === "full" ? overlayHeight(w, h, style) : 0;
  const infoWidth =
    style.layout === "full" && style.showDetails
      ? Math.min(w * 0.24, (h - panelHeight) * 0.8)
      : 0;
  const videoBox = {
    x: 0,
    y: 0,
    width: w - infoWidth,
    height: h - panelHeight,
  };
  return {
    video: containRect(sourceWidth, sourceHeight, videoBox),
    info: infoWidth
      ? { x: w - infoWidth, y: 0, width: infoWidth, height: h - panelHeight }
      : null,
    panelHeight,
  };
}

function lines(ctx, value, width, maxLines = 2) {
  const words = String(value).split(/\s+/);
  const result = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      result.push(line);
      line = word;
    } else line = next;
  }
  if (line) result.push(line);
  const clipped = result.slice(0, maxLines);
  if (result.length > maxLines) clipped[maxLines - 1] += "…";
  return clipped.map((line) => {
    while (ctx.measureText(line).width > width && line.length > 1)
      line = line.slice(0, -2) + "…";
    return line;
  });
}

const detailsLayouts = new WeakMap();

function middleEllipsis(ctx, value, width) {
  const text = String(value);
  if (ctx.measureText(text).width <= width) return text;
  const dot = text.lastIndexOf(".");
  // Retain the extension as well as both ends of a long source filename.
  const suffixLength = dot > 0 && text.length - dot <= 12 ? text.length - dot : 0;
  for (let count = text.length - 1; count > suffixLength; count--) {
    const end = Math.max(suffixLength, Math.floor(count * 0.4));
    const result = `${text.slice(0, count - end)}…${text.slice(-end)}`;
    if (ctx.measureText(result).width <= width) return result;
  }
  return "…";
}

function filenameLines(ctx, value, width, count) {
  const text = String(value);
  if (count === 1 || ctx.measureText(text).width <= width)
    return [middleEllipsis(ctx, text, width)];
  let split = text.length - 1;
  while (split > 1 && ctx.measureText(text.slice(0, split)).width > width)
    split--;
  const word = text.slice(0, split).search(/[ _-][^ _-]*$/);
  if (word > split * 0.55) split = word + 1;
  return [
    text.slice(0, split).trimEnd(),
    middleEllipsis(ctx, text.slice(split).trimStart(), width),
  ];
}

// Cache source names and metadata wrapping. Their length never changes the
// scale of the current frame, totals, or source synchronization diagnostics.
function detailsLayout(ctx, width, height, metadata, sourceInfo, hasTotals, data) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(metadata.testDate)
    ? metadata.testDate
    : "";
  const logRate =
    metadata.sampleRate?.trim() ||
    (data?.points.length > 1 && data.duration > 0
      ? `${((data.points.length - 1) / data.duration).toFixed(1)} Hz`
      : "");
  const fields = [
    ["TEST ID", metadata.testId],
    ["LOCATION", metadata.location],
    ["LOGGER", metadata.logger],
    ...(!sourceInfo ? [["LOG RATE", logRate]] : []),
    ["CAMERA", metadata.camera],
    ["NOTES", metadata.notes],
  ].filter(([, value]) => value?.trim());
  const names = [
    ["VIDEO", sourceInfo?.videoName],
    ["LOG", sourceInfo?.logName],
  ].filter(([, value]) => value?.trim());
  const key = JSON.stringify([
    width,
    height,
    metadata.motor,
    date,
    fields,
    names,
    logRate,
    hasTotals,
    !!sourceInfo,
    !!sourceInfo?.timestamps?.length,
  ]);
  const cached = detailsLayouts.get(ctx);
  if (cached?.key === key) return cached.layout;
  const compact = height < 420;
  const labelWidth = Math.min(70, width * 0.31);
  ctx.font = "600 21px system-ui, -apple-system, sans-serif";
  const model = metadata.motor.trim()
    ? lines(ctx, metadata.motor.trim(), width, 2)
    : [];
  const headerHeight =
    model.length * 25 + (date ? 21 : 0) + (model.length || date ? 9 : 0);
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  const files = names.map(([label, value]) => ({
    label,
    lines: filenameLines(ctx, value, width, compact ? 1 : 2),
  }));
  ctx.font = "10px system-ui, -apple-system, sans-serif";
  const rate = middleEllipsis(ctx, logRate, width - 40);
  const filesHeight = files.reduce(
    (sum, file) => sum + 16 + file.lines.length * 16 + 5,
    0,
  );
  const resultsHeight = hasTotals ? 26 + hasTotals * 27 + 6 : 0;
  const sourceHeight = sourceInfo
    ? 26 + (sourceInfo.timestamps?.length ? 56 : 0) + 17 + filesHeight
    : 0;
  let available = height - 21 - headerHeight - resultsHeight - sourceHeight - 26;
  const rows = [];
  // Source identities and synchronization diagnostics take priority on short
  // exports. Optional records use the remaining room at a fixed readable size.
  for (const [label, value] of fields) {
    if (available < 21) break;
    const count = label === "NOTES" && available >= 42 ? 2 : 1;
    const wrapped = lines(ctx, value, width - labelWidth - 10, count);
    rows.push({ label, lines: wrapped });
    available -= wrapped.length * 16 + 5;
  }
  const layout = {
    date,
    model,
    files,
    rate,
    rows,
    labelWidth,
  };
  detailsLayouts.set(ctx, { key, layout });
  return layout;
}

function drawDetails(
  ctx,
  box,
  metadata,
  data,
  style,
  sourceInfo,
  videoTime,
  offset,
  timeScale,
) {
  const baseWidth = ctx.canvas.height > ctx.canvas.width ? 900 : 1120;
  const scale = Math.min(ctx.canvas.width / baseWidth, box.height / 390);
  ctx.save();
  ctx.translate(box.x, box.y);
  ctx.scale(scale, scale);
  const width = box.width / scale;
  const height = box.height / scale;
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  const light = style.theme === "light";
  const fg = light ? "#24313d" : "#edf2f6";
  const muted = light ? "#61717f" : "#9eafbc";
  const accent = light ? "#ad4f29" : "#e9a56c";
  const pressure = light ? "#177f85" : "#69c9c7";
  const rule = light ? "#dce3e9" : "#ffffff18";
  ctx.fillStyle = light ? "#f1f4f7" : "#16212b";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, height);
  ctx.stroke();
  const padding = 18;
  const contentW = width - padding * 2;
  const font = (size, weight = 400) => {
    ctx.font = `${weight} ${size}px system-ui, -apple-system, sans-serif`;
  };
  const drawText = (
    value,
    x,
    y,
    color,
    align = "left",
    maxWidth = contentW,
  ) => {
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(value, x, y, maxWidth);
  };
  const totals = data
    ? cumulativeAt(
        data,
        style.summaryMode === "final"
          ? data.end
          : dataTimeAt(videoTime, offset, timeScale),
      )
    : null;
  const totalsHeading =
    totals?.phase === "complete"
      ? "FINAL RESULTS"
      : totals?.phase === "pending"
        ? "AWAITING DATA"
        : totals?.phase === "gap"
          ? "LIVE TOTALS · DATA GAP"
          : "LIVE TOTALS";
  const stats = totals
    ? [
        [
          "PEAK THRUST",
          `${formatValue(displayThrust(totals.peakThrust, style.thrustUnit))} ${style.thrustUnit}`,
        ],
        ...(style.showPressure
          ? [
              [
                "PEAK PRESSURE",
                `${formatValue(displayPressure(totals.peakPressure, style.pressureUnit))} ${style.pressureUnit}`,
              ],
            ]
          : []),
        [
          "TOTAL IMPULSE",
          `${formatValue(displayThrust(totals.impulse, style.thrustUnit))} ${style.thrustUnit}·s`,
        ],
      ]
    : [];
  const frame = sourceInfo?.timestamps
    ? frameInfoAt(sourceInfo.timestamps, videoTime, sourceInfo.end)
    : null;
  const logPosition = logPositionAt(
    data,
    dataTimeAt(videoTime, offset, timeScale),
  );
  const layout = detailsLayout(
    ctx,
    contentW,
    height - padding * 2,
    metadata,
    sourceInfo,
    stats.length,
    data,
  );
  ctx.translate(padding, padding);
  let y = 21;
  font(21, 650);
  for (const line of layout.model) {
    drawText(line, 0, y, fg);
    y += 25;
  }
  if (layout.date) {
    font(12, 500);
    drawText(layout.date, 0, y - (layout.model.length ? 1 : 8), muted);
    y += 21;
  }
  if (layout.model.length || layout.date) y += 9;

  const heading = (label) => {
    ctx.strokeStyle = rule;
    ctx.beginPath();
    ctx.moveTo(0, y - 9);
    ctx.lineTo(contentW, y - 9);
    ctx.stroke();
    font(10.5, 650);
    drawText(label, 0, y + 6, muted);
    y += 26;
  };
  if (stats.length) {
    heading(totalsHeading);
    for (const [label, value] of stats) {
      font(11, 550);
      drawText(label, 0, y, muted, "left", contentW * 0.43);
      font(16, 600);
      drawText(
        value,
        contentW,
        y + 1,
        label === "PEAK PRESSURE" ? pressure : accent,
        "right",
        contentW * 0.55,
      );
      y += 27;
    }
    y += 6;
  }
  if (sourceInfo) {
    heading("VIDEO & LOG");
    if (frame) {
      font(13, 600);
      drawText(
        `Frame ${String(frame.number).padStart(6, "0")} / ${sourceInfo.timestamps.length.toLocaleString("en-US")}`,
        0,
        y,
        fg,
      );
      y += 19;
      font(12);
      drawText(`${frame.timestamp.toFixed(6)} s`, 0, y, muted);
      y += 18;
      const csvLabel = logPosition?.first
        ? `CSV row ${logPosition.first.line}${logPosition.second ? ` → ${logPosition.second.line}` : ""}${logPosition.phase === "gap" ? " · GAP" : ""}`
        : `CSV row —${logPosition?.phase === "before" ? " · awaiting data" : logPosition?.phase === "after" ? " · complete" : ""}`;
      drawText(csvLabel, 0, y, muted);
      y += 19;
    }
    font(10.5);
    drawText(
      `${sourceInfo.width} × ${sourceInfo.height} · ${sourceInfo.fps > 0 ? sourceInfo.fps.toFixed(2).replace(/\.00$/, "") : "—"} fps`,
      0,
      y,
      muted,
      "left",
      layout.rate && !sourceInfo.logName ? contentW * 0.75 : contentW,
    );
    if (layout.rate && !sourceInfo.logName) {
      font(10);
      drawText(layout.rate, contentW, y, muted, "right", contentW * 0.23);
    }
    y += 17;
    for (const file of layout.files) {
      font(10, 600);
      drawText(file.label, 0, y, muted);
      if (file.label === "LOG" && layout.rate) {
        font(10);
        drawText(layout.rate, contentW, y, muted, "right", contentW - 40);
      }
      y += 16;
      font(12, 500);
      for (const line of file.lines) {
        drawText(line, 0, y, fg);
        y += 16;
      }
      y += 5;
    }
  }
  if (layout.rows.length) {
    heading("TEST RECORD");
    for (const row of layout.rows) {
      font(9.5, 600);
      drawText(row.label, 0, y, muted, "left", layout.labelWidth);
      font(12);
      for (const line of row.lines) {
        drawText(
          line,
          layout.labelWidth + 10,
          y,
          fg,
          "left",
          contentW - layout.labelWidth - 10,
        );
        y += 16;
      }
      y += 5;
    }
  }
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {number} w @param {number} h
 * @param {{start:number,end:number}|null} measurement
 * @param {((ctx:CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x:number, y:number, width:number, height:number) => void) | null} paintVideo
 */
export function drawComposition(
  ctx,
  w,
  h,
  paintVideo,
  sourceWidth,
  sourceHeight,
  data,
  reduced,
  videoTime,
  offset,
  timeScale,
  style,
  metadata,
  sourceInfo,
  measurement = null,
) {
  ctx.save();
  if (style.layout === "full") {
    ctx.fillStyle = style.theme === "light" ? "#e4e9ee" : "#0b1218";
    ctx.fillRect(0, 0, w, h);
    const geometry = compositionGeometry(
      w,
      h,
      sourceWidth,
      sourceHeight,
      style,
    );
    const v = geometry.video;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.x, v.y, v.width, v.height);
    ctx.clip();
    if (paintVideo) paintVideo(ctx, v.x, v.y, v.width, v.height);
    else drawEmpty(ctx, w, h);
    ctx.restore();
    if (geometry.info)
      drawDetails(
        ctx,
        geometry.info,
        metadata,
        data,
        style,
        sourceInfo,
        videoTime,
        offset,
        timeScale,
      );
    drawOverlay(
      ctx,
      w,
      h,
      data,
      reduced,
      videoTime,
      offset,
      timeScale,
      {
        ...style,
        opacity: 100,
      },
      measurement,
    );
  } else {
    ctx.fillStyle = "#0d1519";
    ctx.fillRect(0, 0, w, h);
    const v = containRect(sourceWidth, sourceHeight, {
      x: 0,
      y: 0,
      width: w,
      height: h,
    });
    if (paintVideo) paintVideo(ctx, v.x, v.y, v.width, v.height);
    else drawEmpty(ctx, w, h);
    drawOverlay(
      ctx,
      w,
      h,
      data,
      reduced,
      videoTime,
      offset,
      timeScale,
      style,
      measurement,
    );
  }
  ctx.restore();
}
