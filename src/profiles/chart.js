import { displayPressure, displayThrust } from "../units.js";
import { textLines } from "../canvas-text.js";

const font = "system-ui, -apple-system, sans-serif";
const clamp = (value, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, value));

function niceStep(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value || 1));
  return (
    [1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= value) *
    magnitude
  );
}

function ticksBetween(start, end, step) {
  const first = Math.ceil((start - step * 1e-10) / step) * step;
  const ticks = [];
  for (let index = 0; index < 100; index++) {
    const value = first + index * step;
    if (value > end + step * 1e-9) break;
    ticks.push(Math.abs(value) < step * 1e-10 ? 0 : value);
  }
  return ticks;
}

function axisRange(minimum, maximum, count) {
  let low = Math.min(0, minimum);
  let high = Math.max(0, maximum);
  const span = high - low || 1;
  if (low < 0) low -= span * 0.06;
  if (high > 0) high += span * 0.06;
  if (high === low) high = low + span;
  const step = niceStep((high - low) / count);
  low = Math.floor(low / step) * step;
  high = Math.max(low + step, Math.ceil(high / step) * step);
  return { min: low, max: high, step, ticks: ticksBetween(low, high, step) };
}

function numberLabel(value, step) {
  const absolute = Math.abs(value);
  if (absolute >= 1e6 || (absolute > 0 && absolute < 0.0001))
    return value.toExponential(1);
  const magnitude = Math.floor(Math.log10(step || 1));
  const extra = step / 10 ** magnitude === 2.5 ? 1 : 0;
  const decimals = clamp(-magnitude + extra, 0, 8);
  return Number(value.toFixed(decimals)).toLocaleString(undefined, {
    maximumFractionDigits: decimals,
    useGrouping: absolute >= 10000,
  });
}

function validView(value) {
  return (
    value &&
    Number.isFinite(value.start) &&
    Number.isFinite(value.end) &&
    value.end > value.start
  );
}

function sampleAtX(series, x) {
  const { xs, ys, gaps, direction, monotonic } = series;
  if (!xs.length) return null;
  let index;
  if (monotonic) {
    let low = 0,
      high = xs.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (xs[middle] * direction < x * direction) low = middle + 1;
      else high = middle;
    }
    index = low;
  } else {
    index = xs.findIndex(
      (value, point) =>
        value === x ||
        (point > 0 &&
          x >= Math.min(xs[point - 1], value) &&
          x <= Math.max(xs[point - 1], value)),
    );
  }
  if (index < 0 || index >= xs.length) return null;
  if (Math.abs(xs[index] - x) < 1e-12) return ys[index];
  if (!index || gaps[index]) return null;
  const before = index - 1;
  const interval = xs[index] - xs[before];
  if (!interval) return null;
  return ys[before] + ((x - xs[before]) / interval) * (ys[index] - ys[before]);
}

/**
 * Draw and navigate mapped, browser-local telemetry profiles on one canvas.
 * The caller owns the shared viewport and receives completed marker edits.
 */
export function createProfileChart(canvas, callbacks = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("A two-dimensional canvas is required.");
  const cache = new Map();
  const controller = new AbortController();
  const originalCursor = canvas.style.cursor;
  const originalTouchAction = canvas.style.touchAction;
  const originalTabIndex = canvas.getAttribute("tabindex");
  let model = { series: [], markers: [], crosshair: null };
  let prepared = [];
  let domain = { start: 0, end: 1 };
  let view = { ...domain };
  let width = 640,
    height = 320,
    ratio = 1;
  let revision = 0;
  let layout = null,
    layoutKey = "";
  let scheduled = 0,
    pickTimer = 0;
  let gesture = null,
    hover = null,
    emittedHover = null;
  let disposed = false;
  if (canvas.tabIndex < 0) canvas.tabIndex = 0;
  canvas.style.touchAction = "none";

  function prepare(series, metric, unit, index) {
    const points = series.points || [];
    const id = series.id ?? index;
    const offset = series.mapping?.offset ?? 0;
    const scale = series.mapping?.scale ?? 1;
    const band = ["sd", "range"].includes(series.band) ? series.band : null;
    const appearance = {
      color: series.color || "#315f9b",
      lineWidth: Number.isFinite(series.lineWidth) ? clamp(series.lineWidth, 0.5, 6) : 2,
      dash: Array.isArray(series.dash) ? series.dash : [],
    };
    const existing = cache.get(id);
    if (
      existing?.points === points &&
      existing.metric === metric &&
      existing.unit === unit &&
      existing.offset === offset &&
      existing.scale === scale &&
      existing.band === band
    )
      return { ...existing, ...appearance };
    const convert = metric === "pressure" ? displayPressure : displayThrust;
    const xs = [],
      ys = [],
      gaps = [],
      lowers = [],
      uppers = [];
    let start = Infinity,
      end = -Infinity,
      minimum = Infinity,
      maximum = -Infinity;
    let gap = true;
    for (const point of points) {
      const x = offset + point.t * scale;
      if (Number.isFinite(x)) {
        start = Math.min(start, x);
        end = Math.max(end, x);
      }
      const value = point[metric];
      const y = Number.isFinite(value) ? convert(value, unit) : NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        gap = true;
        continue;
      }
      xs.push(x);
      ys.push(y);
      gaps.push(gap || Boolean(point.gapBefore));
      minimum = Math.min(minimum, y);
      maximum = Math.max(maximum, y);
      let lower = NaN,
        upper = NaN;
      if (band && Number.isFinite(point.n) && point.n >= 2) {
        const deviation = point[`${metric}Sd`];
        const low = band === "sd" ? value - deviation : point[`${metric}Min`];
        const high = band === "sd" ? value + deviation : point[`${metric}Max`];
        if (
          (band !== "sd" || (Number.isFinite(deviation) && deviation >= 0)) &&
          Number.isFinite(low) && Number.isFinite(high) && low <= high
        ) {
          lower = convert(low, unit);
          upper = convert(high, unit);
          if (Number.isFinite(lower) && Number.isFinite(upper)) {
            minimum = Math.min(minimum, lower);
            maximum = Math.max(maximum, upper);
          } else lower = upper = NaN;
        }
      }
      lowers.push(lower);
      uppers.push(upper);
      gap = false;
    }
    const direction = xs.length > 1 && xs.at(-1) < xs[0] ? -1 : 1;
    const monotonic = xs.every(
      (value, point) => !point || value * direction >= xs[point - 1] * direction,
    );
    const entry = {
      id,
      points,
      metric,
      unit,
      offset,
      scale,
      band,
      xs: Float64Array.from(xs),
      ys: Float64Array.from(ys),
      gaps: Uint8Array.from(gaps),
      lowers: Float64Array.from(lowers),
      uppers: Float64Array.from(uppers),
      start,
      end,
      minimum,
      maximum,
      direction,
      monotonic,
      revision: ++revision,
      pathKey: "",
      path: null,
      dots: null,
      bandPath: null,
    };
    cache.set(id, entry);
    return { ...entry, ...appearance };
  }

  function measure() {
    const bounds = canvas.getBoundingClientRect();
    width = bounds.width || canvas.clientWidth || width;
    height = bounds.height || canvas.clientHeight || height;
    ratio = window.devicePixelRatio || 1;
  }

  function ensureLayout() {
    const key = [
      width,
      height,
      view.start,
      view.end,
      ...prepared.map((series) => series.revision),
    ].join(":");
    if (key === layoutKey) return layout;
    let minimum = Infinity,
      maximum = -Infinity;
    for (const series of prepared) {
      const { xs, ys, gaps, lowers, uppers } = series;
      for (let index = 0; index < xs.length; index++) {
        const x = xs[index];
        if (x >= view.start && x <= view.end) {
          minimum = Math.min(minimum, ys[index]);
          maximum = Math.max(maximum, ys[index]);
          if (Number.isFinite(lowers[index])) {
            minimum = Math.min(minimum, lowers[index]);
            maximum = Math.max(maximum, uppers[index]);
          }
        }
        if (!index || gaps[index]) continue;
        const previous = xs[index - 1];
        if (
          Math.max(previous, x) < view.start ||
          Math.min(previous, x) > view.end ||
          previous === x
        )
          continue;
        for (const boundary of [view.start, view.end]) {
          if (boundary < Math.min(previous, x) || boundary > Math.max(previous, x))
            continue;
          const value =
            ys[index - 1] +
            ((boundary - previous) / (x - previous)) *
              (ys[index] - ys[index - 1]);
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
          if (Number.isFinite(lowers[index - 1]) && Number.isFinite(lowers[index])) {
            const fraction = (boundary - previous) / (x - previous);
            minimum = Math.min(minimum, lowers[index - 1] + fraction * (lowers[index] - lowers[index - 1]));
            maximum = Math.max(maximum, uppers[index - 1] + fraction * (uppers[index] - uppers[index - 1]));
          }
        }
      }
    }
    if (!Number.isFinite(minimum)) {
      minimum = Math.min(0, ...prepared.map((series) => series.minimum));
      maximum = Math.max(0, ...prepared.map((series) => series.maximum));
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
      minimum = 0;
      maximum = 1;
    }
    const axis = axisRange(minimum, maximum, clamp(Math.floor(height / 65), 3, 7));
    ctx.font = `11px ${font}`;
    const labelWidth = Math.max(
      0,
      ...axis.ticks.map((value) => ctx.measureText(numberLabel(value, axis.step)).width),
    );
    const left = Math.max(62, labelWidth + 37);
    const plot = {
      x: left,
      y: 24,
      width: Math.max(1, width - left - 22),
      height: Math.max(1, height - 80),
    };
    const step = niceStep((view.end - view.start) / clamp(Math.floor(plot.width / 95), 2, 12));
    layout = {
      plot,
      axis,
      xStep: step,
      xTicks: ticksBetween(view.start, view.end, step),
      toX: (x) => plot.x + ((x - view.start) / (view.end - view.start)) * plot.width,
      fromX: (x) => view.start + ((x - plot.x) / plot.width) * (view.end - view.start),
      toY: (y) => plot.y + plot.height - ((y - axis.min) / (axis.max - axis.min)) * plot.height,
    };
    layoutKey = key;
    return layout;
  }

  function write(value, x, y, align = "left", maximumWidth) {
    ctx.textAlign = align;
    ctx.fillText(
      maximumWidth === undefined
        ? value
        : textLines(ctx, value, maximumWidth, 1)[0] || "",
      x,
      y,
    );
  }

  function pathFor(series, geometry) {
    const key = layoutKey;
    const entry = cache.get(series.id);
    if (entry.pathKey === key) return entry;
    const path = new Path2D();
    const dots = new Path2D();
    const bandPath = new Path2D();
    const { xs, ys, gaps, lowers, uppers } = series;
    let joined = false;
    let visibleCount = 0;
    for (const x of xs)
      if (x >= view.start && x <= view.end) visibleCount++;
    for (let index = 0; index < xs.length; index++) {
      const x = xs[index],
        y = ys[index];
      const inside = x >= view.start && x <= view.end;
      if (gaps[index]) joined = false;
      const intersects =
        index > 0 &&
        !gaps[index] &&
        Math.max(xs[index - 1], x) >= view.start &&
        Math.min(xs[index - 1], x) <= view.end;
      if (intersects) {
        if (!joined)
          path.moveTo(geometry.toX(xs[index - 1]), geometry.toY(ys[index - 1]));
        path.lineTo(geometry.toX(x), geometry.toY(y));
        joined = true;
      } else {
        joined = inside;
        if (inside) path.moveTo(geometry.toX(x), geometry.toY(y));
      }
      if (
        inside &&
        (visibleCount <= 24 ||
          ((index === 0 || gaps[index]) &&
            (index === xs.length - 1 || gaps[index + 1])))
      ) {
        const px = geometry.toX(x),
          py = geometry.toY(y);
        dots.moveTo(px + 2.2, py);
        dots.arc(px, py, 2.2, 0, Math.PI * 2);
      }
    }
    if (series.band) {
      let segment = [];
      const closeBand = () => {
        if (segment.length > 1) {
          bandPath.moveTo(geometry.toX(xs[segment[0]]), geometry.toY(uppers[segment[0]]));
          for (const index of segment.slice(1))
            bandPath.lineTo(geometry.toX(xs[index]), geometry.toY(uppers[index]));
          for (let index = segment.length - 1; index >= 0; index--)
            bandPath.lineTo(geometry.toX(xs[segment[index]]), geometry.toY(lowers[segment[index]]));
          bandPath.closePath();
        }
        segment = [];
      };
      for (let index = 1; index < xs.length; index++) {
        const intersects = !gaps[index] &&
          Number.isFinite(lowers[index - 1]) && Number.isFinite(lowers[index]) &&
          Math.max(xs[index - 1], xs[index]) >= view.start &&
          Math.min(xs[index - 1], xs[index]) <= view.end;
        if (!intersects) closeBand();
        else {
          if (!segment.length) segment.push(index - 1);
          segment.push(index);
        }
      }
      closeBand();
    }
    Object.assign(entry, { pathKey: key, path, dots, bandPath });
    return entry;
  }

  function draw() {
    scheduled = 0;
    if (disposed) return;
    measure();
    const backingWidth = Math.max(1, Math.round(width * ratio));
    const backingHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const geometry = ensureLayout();
    const { plot, axis, toX, toY } = geometry;
    const bottom = plot.y + plot.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.font = `11px ${font}`;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (const tick of axis.ticks) {
      const y = toY(tick);
      ctx.strokeStyle = "#e5eaf0";
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.width, y);
      ctx.stroke();
      ctx.fillStyle = "#647384";
      write(numberLabel(tick, axis.step), plot.x - 10, y + 4, "right");
    }
    for (const tick of geometry.xTicks) {
      const x = toX(tick);
      ctx.strokeStyle = "#edf0f4";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.fillStyle = "#647384";
      write(numberLabel(tick, geometry.xStep), x, bottom + 20, "center");
    }
    ctx.setLineDash([]);
    if (model.zeroLine !== false && axis.min <= 0 && axis.max >= 0) {
      ctx.strokeStyle = "#aab7c6";
      ctx.beginPath();
      ctx.moveTo(plot.x, toY(0));
      ctx.lineTo(plot.x + plot.width, toY(0));
      ctx.stroke();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.width, plot.height);
    ctx.clip();
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.save();
    ctx.globalAlpha = 0.13;
    for (const series of prepared) {
      if (!series.band) continue;
      ctx.fillStyle = series.color;
      ctx.fill(pathFor(series, geometry).bandPath);
    }
    ctx.restore();
    for (const series of prepared) {
      const paths = pathFor(series, geometry);
      ctx.lineWidth = series.lineWidth;
      ctx.strokeStyle = series.color;
      ctx.fillStyle = series.color;
      ctx.setLineDash(series.dash);
      ctx.stroke(paths.path);
      ctx.fill(paths.dots);
    }
    ctx.setLineDash([]);
    ctx.restore();
    ctx.strokeStyle = "#cbd5df";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.y);
    ctx.lineTo(plot.x, bottom);
    ctx.lineTo(plot.x + plot.width, bottom);
    ctx.stroke();
    ctx.fillStyle = "#455568";
    ctx.font = `500 12px ${font}`;
    write(model.xLabel || "", plot.x + plot.width / 2, height - 10, "center", plot.width);
    ctx.save();
    ctx.translate(14, plot.y + plot.height / 2);
    ctx.rotate(-Math.PI / 2);
    write(model.yLabel || "", 0, 0, "center", plot.height);
    ctx.restore();

    for (const marker of model.markers || []) {
      const value =
        gesture?.type === "marker" && gesture.markerId === marker.id
          ? gesture.previewX
          : marker.x;
      if (!Number.isFinite(value) || value < view.start || value > view.end)
        continue;
      const x = toX(value);
      const color = marker.color || "#506b93";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - 4, plot.y);
      ctx.lineTo(x + 4, plot.y);
      ctx.lineTo(x, plot.y + 7);
      ctx.closePath();
      ctx.fill();
      ctx.font = `600 11px ${font}`;
      const label =
        textLines(
          ctx,
          marker.label || marker.id,
          Math.min(140, plot.width),
          1,
        )[0] || "";
      const labelWidth = ctx.measureText(label).width + 12;
      const labelX = clamp(x - labelWidth / 2, plot.x, plot.x + plot.width - labelWidth);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(labelX, plot.y - 22, labelWidth, 19);
      ctx.fillStyle = color;
      write(label, labelX + labelWidth / 2, plot.y - 8, "center");
    }

    const cursor = gesture?.type === "marker" ? gesture.previewX : hover ?? model.crosshair;
    if (Number.isFinite(cursor) && cursor >= view.start && cursor <= view.end) {
      const x = toX(cursor);
      ctx.save();
      ctx.beginPath();
      ctx.rect(plot.x, plot.y, plot.width, plot.height);
      ctx.clip();
      ctx.strokeStyle = "#7c8b9d";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const series of prepared) {
        const value = sampleAtX(series, cursor);
        if (value === null || !Number.isFinite(value)) continue;
        ctx.beginPath();
        ctx.arc(x, toY(value), 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = series.color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
      ctx.font = `600 11px ${font}`;
      const label = numberLabel(cursor, (view.end - view.start) / 1000);
      const labelWidth = ctx.measureText(label).width + 14;
      const labelX = clamp(x - labelWidth / 2, plot.x, plot.x + plot.width - labelWidth);
      ctx.fillStyle = "#344a63";
      ctx.fillRect(labelX, bottom + 4, labelWidth, 21);
      ctx.fillStyle = "#ffffff";
      write(label, labelX + labelWidth / 2, bottom + 19, "center");
    }
  }

  function schedule() {
    if (!scheduled && !disposed) scheduled = requestAnimationFrame(draw);
  }

  function setView(next) {
    if (disposed) return;
    view = next ? { ...next } : { ...domain };
    schedule();
    callbacks.onViewChange?.(next ? { ...view } : null);
  }

  function zoom(factor, anchor) {
    const span = view.end - view.start;
    const full = domain.end - domain.start;
    const nextSpan = clamp(span * factor, Math.max(1e-9, full / 1e6), Math.max(full * 20, span));
    const fraction = (anchor - view.start) / span;
    setView({
      start: anchor - nextSpan * fraction,
      end: anchor + nextSpan * (1 - fraction),
    });
  }

  function pointAt(event) {
    measure();
    const geometry = ensureLayout();
    const bounds = canvas.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / (bounds.width || 1)) * width;
    const y = ((event.clientY - bounds.top) / (bounds.height || 1)) * height;
    const { plot } = geometry;
    return {
      x,
      y,
      value: geometry.fromX(x),
      inside:
        x >= plot.x &&
        x <= plot.x + plot.width &&
        y >= plot.y &&
        y <= plot.y + plot.height,
    };
  }

  function markerAt(point) {
    if (!point.inside || !callbacks.onMarkerChange) return null;
    const geometry = ensureLayout();
    return (
      (model.markers || [])
        .filter(
          (marker) =>
            Number.isFinite(marker.x) &&
            marker.x >= view.start &&
            marker.x <= view.end &&
            Math.abs(geometry.toX(marker.x) - point.x) <= 8,
        )
        .sort(
          (first, second) =>
            Math.abs(geometry.toX(first.x) - point.x) -
            Math.abs(geometry.toX(second.x) - point.x),
        )[0] || null
    );
  }

  function reportHover(value) {
    hover = value;
    if (value !== emittedHover) {
      emittedHover = value;
      callbacks.onHover?.(value);
    }
    schedule();
  }

  function move(event) {
    const point = pointAt(event);
    if (gesture && gesture.pointerId === event.pointerId) {
      const dx = point.x - gesture.startX;
      const dy = point.y - gesture.startY;
      if (Math.hypot(dx, dy) > 3) gesture.dragged = true;
      if (gesture.type === "marker") {
        gesture.previewX = clamp(point.value, view.start, view.end);
        canvas.style.cursor = "ew-resize";
        reportHover(gesture.previewX);
      } else if (gesture.dragged) {
        const span = gesture.startView.end - gesture.startView.start;
        const delta = (-dx / gesture.startWidth) * span;
        setView({
          start: gesture.startView.start + delta,
          end: gesture.startView.end + delta,
        });
        canvas.style.cursor = "grabbing";
        reportHover(ensureLayout().fromX(point.x));
      }
      schedule();
      return;
    }
    canvas.style.cursor = markerAt(point) ? "ew-resize" : point.inside ? "crosshair" : "default";
    reportHover(point.inside ? point.value : null);
  }

  function cancelGesture(event) {
    if (!gesture) return;
    if (event?.pointerId !== undefined && event.pointerId !== gesture.pointerId)
      return;
    const previous = gesture;
    gesture = null;
    if (canvas.hasPointerCapture(previous.pointerId))
      canvas.releasePointerCapture(previous.pointerId);
    if (previous.type === "pan" && previous.dragged) setView(previous.startView);
    canvas.style.cursor = "crosshair";
    schedule();
  }

  const listen = (name, handler, options = {}) =>
    canvas.addEventListener(name, handler, { ...options, signal: controller.signal });
  listen("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false || gesture) return;
    const point = pointAt(event);
    if (!point.inside) return;
    clearTimeout(pickTimer);
    const marker = markerAt(point);
    gesture = {
      type: marker ? "marker" : "pan",
      pointerId: event.pointerId,
      markerId: marker?.id,
      previewX: marker?.x ?? point.value,
      startX: point.x,
      startY: point.y,
      startWidth: ensureLayout().plot.width,
      startView: { ...view },
      dragged: false,
    };
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  listen("pointermove", move);
  listen("pointerup", (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    move(event);
    const completed = gesture;
    gesture = null;
    if (canvas.hasPointerCapture(event.pointerId))
      canvas.releasePointerCapture(event.pointerId);
    if (completed.type === "marker" && completed.dragged)
      callbacks.onMarkerChange?.(completed.markerId, completed.previewX);
    else if (!completed.dragged) {
      const point = pointAt(event);
      if (point.inside) {
        // Leave double-click available for fitting without committing a pick.
        pickTimer = window.setTimeout(() => {
          pickTimer = 0;
          if (!disposed) callbacks.onPick?.(point.value);
        }, 220);
      }
    }
    const point = pointAt(event);
    canvas.style.cursor = markerAt(point) ? "ew-resize" : "crosshair";
    schedule();
  });
  listen("pointercancel", cancelGesture);
  listen("lostpointercapture", cancelGesture);
  listen("pointerleave", () => {
    if (!gesture) {
      canvas.style.cursor = "default";
      reportHover(null);
    }
  });
  listen("dblclick", (event) => {
    if (!pointAt(event).inside) return;
    clearTimeout(pickTimer);
    event.preventDefault();
    setView(null);
  });
  listen("wheel", (event) => {
    const point = pointAt(event);
    if (!point.inside) return;
    event.preventDefault();
    if (gesture) return;
    clearTimeout(pickTimer);
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
    zoom(Math.exp(clamp(delta, -300, 300) * 0.002), point.value);
    reportHover(ensureLayout().fromX(point.x));
  }, { passive: false });
  listen("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (gesture) {
      if (event.key === "Escape") {
        cancelGesture();
        event.preventDefault();
      }
      return;
    }
    const span = view.end - view.start;
    const anchor = Number.isFinite(hover) ? hover : (view.start + view.end) / 2;
    if (event.key === "Home") setView(null);
    else if (event.key === "+" || event.key === "=") zoom(0.8, anchor);
    else if (event.key === "-" || event.key === "_") zoom(1.25, anchor);
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const delta = span * (event.shiftKey ? 0.5 : 0.1) * (event.key === "ArrowLeft" ? -1 : 1);
      setView({ start: view.start + delta, end: view.end + delta });
    } else return;
    event.preventDefault();
  });
  const observer = new ResizeObserver(schedule);
  observer.observe(canvas);
  window.addEventListener("resize", schedule, { signal: controller.signal });
  schedule();

  return {
    render(next) {
      if (disposed) return;
      model = next;
      const metric = next.metric === "pressure" ? "pressure" : "thrust";
      const unit = next.unit || (metric === "pressure" ? "bar" : "N");
      prepared = (next.series || []).map((series, index) => prepare(series, metric, unit, index));
      const active = new Set(prepared.map((series) => series.id));
      for (const id of cache.keys()) if (!active.has(id)) cache.delete(id);
      let start = Math.min(Infinity, ...prepared.map((series) => series.start));
      let end = Math.max(-Infinity, ...prepared.map((series) => series.end));
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        start = 0;
        end = 1;
      } else if (start === end) {
        const padding = Math.max(0.5, Math.abs(start) * 0.01);
        start -= padding;
        end += padding;
      }
      domain = { start, end };
      view = validView(next.view) ? { ...next.view } : { ...domain };
      schedule();
    },
    fit() {
      setView(null);
    },
    geometry() {
      measure();
      const geometry = ensureLayout();
      return {
        width,
        height,
        plot: { ...geometry.plot },
        view: { ...view },
        domain: { ...domain },
        y: { min: geometry.axis.min, max: geometry.axis.max },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      observer.disconnect();
      cancelAnimationFrame(scheduled);
      clearTimeout(pickTimer);
      if (gesture && canvas.hasPointerCapture(gesture.pointerId))
        canvas.releasePointerCapture(gesture.pointerId);
      gesture = null;
      cache.clear();
      canvas.style.cursor = originalCursor;
      canvas.style.touchAction = originalTouchAction;
      if (originalTabIndex === null) canvas.removeAttribute("tabindex");
      else canvas.setAttribute("tabindex", originalTabIndex);
    },
  };
}
