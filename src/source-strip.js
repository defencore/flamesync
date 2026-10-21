import { dataTimeAt, logPositionAt } from "./data.js";
import { frameInfoAt } from "./timing.js";
import { presentationScale } from "./composition-layout.js";
import { filenameLabel, textLines } from "./canvas-text.js";
import { logRowNumbers, logRateLabel } from "./log-details.js";

const sourceLabels = new WeakMap();

export function drawSourceStrip(
  ctx,
  width,
  height,
  source,
  data,
  videoTime,
  offset,
  timeScale,
  style,
) {
  const scale = presentationScale(width, height);
  const w = width / scale,
    h = height / scale;
  const top = h - 64;
  const light = style.theme === "light";
  const foreground = light ? "#283643" : "#e5edf4";
  const muted = light ? "#64727f" : "#a6b4c0";
  ctx.save();
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.rect(0, top, w, 64);
  ctx.clip();
  ctx.fillStyle = light ? "#edf1f5" : "#15202a";
  ctx.fillRect(0, top, w, 64);
  const nameX = 100;
  const positionX = w * 0.48;
  const clockX = w * 0.71;
  const nameWidth = positionX - nameX - 30;
  ctx.font = "500 18px system-ui, -apple-system, sans-serif";
  const key = JSON.stringify([nameWidth, source?.videoName, source?.logName]);
  let names = sourceLabels.get(ctx);
  if (names?.key !== key) {
    names = {
      key,
      video: filenameLabel(ctx, source?.videoName || "—", nameWidth),
      log: filenameLabel(ctx, source?.logName || "—", nameWidth),
    };
    sourceLabels.set(ctx, names);
  }
  const text = (
    value,
    x,
    y,
    size = 18,
    color = foreground,
    maxWidth = w - x - 24,
    weight = 500,
  ) => {
    ctx.font = `${weight} ${size}px system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.fillText(textLines(ctx, value, maxWidth, 1)[0] || "", x, y);
  };
  const frame = source?.timestamps
    ? frameInfoAt(source.timestamps, videoTime, source.end)
    : null;
  const csvTime = dataTimeAt(videoTime, offset, timeScale);
  const log = logPositionAt(data, csvTime);
  const csvPosition = data?.separateTime ? `Rows ${logRowNumbers(data, csvTime)}` : log?.first
    ? `CSV row ${log.first.line}${
        log.second ? ` → ${log.second.line}` : ""
      }${log.phase === "gap" ? " · GAP" : ""}`
    : `CSV row —${
        log?.phase === "before"
          ? " · awaiting data"
          : log?.phase === "after"
            ? " · complete"
            : ""
      }`;
  const fps = source?.fps > 0 ? `${Number(source.fps.toFixed(2))} fps` : "";
  const rate = logRateLabel(data);
  const rows = [
    [
      "VIDEO",
      names.video,
      frame
        ? `Frame ${String(frame.number).padStart(6, "0")} / ${
            source.timestamps.length.toLocaleString("en-US")
          }`
        : "Frame —",
      frame
        ? `${frame.timestamp.toFixed(6)} s · ${fps} · ${source.width} × ${source.height}`
        : "",
    ],
    [
      "LOG",
      names.log,
      csvPosition,
      data
        ? `CSV ${csvTime.toFixed(6)} s${rate ? ` · ${rate}` : ""}`
        : "",
    ],
  ];
  rows.forEach(([label, name, position, clock], index) => {
    const y = top + 24 + index * 27;
    text(label, 24, y, 15, muted, 70, 650);
    text(name, nameX, y, 18, foreground, nameWidth);
    text(position, positionX, y, 18, foreground, clockX - positionX - 24);
    text(clock, clockX, y, 17, muted);
  });
  ctx.restore();
}
