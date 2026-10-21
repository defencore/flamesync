import { formatValue } from "./data.js";
import { displayThrust, displayPressure } from "./units.js";
import { t } from "./i18n.js";

export function measurementPlotBox(width, height) {
  return { x: 56, y: 28, width: Math.max(1, width - 112), height: height - 64 };
}

export function drawIntervalMarkers(
  ctx,
  box,
  startX,
  endX,
  label,
  light = true,
) {
  const color = light ? "#285ea8" : "#9bbff5";
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  ctx.fillStyle = light ? "#285ea814" : "#9bbff514";
  ctx.fillRect(startX, box.y, endX - startX, box.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  for (const x of [startX, endX]) {
    ctx.beginPath();
    ctx.moveTo(x, box.y);
    ctx.lineTo(x, box.y + box.height);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  const labelWidth = Math.min(ctx.measureText(label).width + 12, box.width);
  const center = Math.max(
    box.x + labelWidth / 2,
    Math.min(box.x + box.width - labelWidth / 2, (startX + endX) / 2),
  );
  ctx.fillStyle = light ? "#ffffffed" : "#142235ed";
  ctx.fillRect(center - labelWidth / 2, box.y + 3, labelWidth, 19);
  ctx.fillStyle = color;
  ctx.fillText(label, center, box.y + 16, Math.max(1, labelWidth - 8));
  ctx.restore();
}

export function drawMeasurementChart(
  ctx,
  width,
  height,
  data,
  reduced,
  measurement,
  units,
) {
  const box = measurementPlotBox(width, height);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = "#627182";
  if (!data) {
    ctx.textAlign = "center";
    ctx.fillText(
      t("Load a CSV log to measure thrust duration."),
      width / 2,
      height / 2,
    );
    return box;
  }
  const x = (time) => box.x + ((time - data.start) / data.duration) * box.width;
  const thrustMin = Math.min(0, data.minThrust);
  const pressureMin = Math.min(0, data.minPressure);
  const thrustMax =
    Math.max(data.peakThrust * 1.08, Math.abs(thrustMin) * 0.08) || 1;
  const pressureMax =
    Math.max(data.peakPressure * 1.08, Math.abs(pressureMin) * 0.08) || 1;
  const y = (v, key) =>
    box.y +
    box.height -
    ((v - (key === "thrust" ? thrustMin : pressureMin)) /
      (key === "thrust" ? thrustMax - thrustMin : pressureMax - pressureMin)) *
      box.height;
  ctx.strokeStyle = "#e1e6ec";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const yy = box.y + (box.height * i) / 2;
    ctx.beginPath();
    ctx.moveTo(box.x, yy);
    ctx.lineTo(box.x + box.width, yy);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillStyle = "#8c542d";
    ctx.fillText(
      formatValue(
        displayThrust(
          thrustMax - ((thrustMax - thrustMin) * i) / 2,
          units.thrustUnit,
        ),
      ),
      box.x - 7,
      yy + 4,
    );
    ctx.textAlign = "left";
    ctx.fillStyle = "#267780";
    ctx.fillText(
      formatValue(
        displayPressure(
          pressureMax - ((pressureMax - pressureMin) * i) / 2,
          units.pressureUnit,
        ),
      ),
      box.x + box.width + 7,
      yy + 4,
    );
  }
  ctx.textAlign = "center";
  ctx.fillStyle = "#8c542d";
  ctx.fillText(units.thrustUnit, box.x / 2, 15);
  ctx.fillStyle = "#267780";
  ctx.fillText(units.pressureUnit, width - box.x / 2, 15);
  ctx.textAlign = "center";
  ctx.fillStyle = "#627182";
  for (let i = 0; i <= 4; i++)
    ctx.fillText(
      `${(data.start + (data.duration * i) / 4).toFixed(2)} s`,
      box.x + (box.width * i) / 4,
      box.y + box.height + 22,
    );
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  for (const [key, color] of [
    ["pressure", "#36838c"],
    ["thrust", "#b26937"],
  ]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    let connected = false;
    reduced.forEach((p) => {
      if (!Number.isFinite(p[key])) { connected = false; return; }
      if (!connected || p[`${key}GapBefore`]) ctx.moveTo(x(p.t), y(p[key], key));
      else ctx.lineTo(x(p.t), y(p[key], key));
      connected = true;
    });
    ctx.stroke();
  }
  ctx.restore();
  if (measurement)
    drawIntervalMarkers(
      ctx,
      box,
      x(measurement.start),
      x(measurement.end),
      measurement.startSet && measurement.endSet
        ? t("Δt {duration} s · CSV", {
            duration: (measurement.end - measurement.start).toFixed(3),
          })
        : t("Set both measurement markers"),
    );
  return box;
}
