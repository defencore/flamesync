import test from "node:test";
import assert from "node:assert/strict";
import { drawComposition, compositionGeometry } from "../src/composition.js";
import {
  defaultStyle,
  defaultMetadata,
  overlayGeometry,
  overlayHeight,
  chartAxis,
  drawOverlay,
  overlayTimeDomain,
} from "../src/overlay.js";
import { parseCSV, chartPoints } from "../src/data.js";
import { presentationScale } from "../src/composition-layout.js";
import { drawMeasurementChart } from "../src/measurement-chart.js";

function recordingContext(width, height) {
  const transforms = [];
  let transform = { x: 0, y: 0, sx: 1, sy: 1 };
  let path = [];
  let dash = [];
  let rectangle = null;
  const context = {
    canvas: { width, height },
    font: "10px system-ui",
    textAlign: "left",
    texts: [],
    outlines: [],
    clips: [],
    strokes: [],
    fills: [],
    measurements: 0,
    save() {
      transforms.push({ ...transform, font: this.font, align: this.textAlign,
        strokeStyle: this.strokeStyle, lineWidth: this.lineWidth,
        globalAlpha: this.globalAlpha, shadowColor: this.shadowColor,
        shadowBlur: this.shadowBlur, dash: [...dash] });
    },
    restore() {
      const saved = transforms.pop();
      transform = saved;
      this.font = saved.font;
      this.textAlign = saved.align;
      this.strokeStyle = saved.strokeStyle;
      this.lineWidth = saved.lineWidth;
      this.globalAlpha = saved.globalAlpha;
      this.shadowColor = saved.shadowColor;
      this.shadowBlur = saved.shadowBlur;
      dash = saved.dash;
    },
    translate(x, y) {
      transform.x += x * transform.sx;
      transform.y += y * transform.sy;
    },
    scale(x, y) {
      transform.sx *= x;
      transform.sy *= y;
    },
    measureText(value) {
      this.measurements++;
      const size = Number(this.font.match(/([\d.]+)px/)[1]);
      return { width: String(value).length * size * 0.54 };
    },
    fillText(value, x, y, maximum = Infinity) {
      const size = Number(this.font.match(/([\d.]+)px/)[1]);
      const naturalWidth = String(value).length * size * 0.54;
      const width = Math.min(naturalWidth, maximum);
      const left =
        this.textAlign === "right"
          ? x - width
          : this.textAlign === "center"
            ? x - width / 2
            : x;
      this.texts.push({
        value: String(value),
        left: transform.x + left * transform.sx,
        right: transform.x + (left + width) * transform.sx,
        top: transform.y + (y - size) * transform.sy,
        bottom: transform.y + (y + size * 0.2) * transform.sy,
        size: size * transform.sy,
        font: this.font,
        maximum,
        naturalWidth,
        alpha: this.globalAlpha ?? 1,
      });
    },
    strokeText(value, x, y) {
      this.outlines.push({ value, x, y, color: this.strokeStyle, width: this.lineWidth,
        shadow: this.shadowBlur });
    },
    beginPath() { path = []; rectangle = null; },
    rect(x, y, width, height) {
      rectangle = { x: transform.x + x * transform.sx, y: transform.y + y * transform.sy,
        width: width * transform.sx, height: height * transform.sy };
    },
    clip() { if (rectangle) this.clips.push({ ...rectangle }); },
    clearRect() {},
    fillRect(x, y, width, height) {
      this.fills.push({ color: this.fillStyle,
        x: transform.x + x * transform.sx, y: transform.y + y * transform.sy,
        width: width * transform.sx, height: height * transform.sy });
    },
    stroke() { this.strokes.push({ points: [...path], color: this.strokeStyle,
      lineWidth: this.lineWidth, alpha: this.globalAlpha, dash: [...dash] }); },
    moveTo(x, y) { path.push({ type: "move", x: transform.x + x * transform.sx,
      y: transform.y + y * transform.sy }); },
    lineTo(x, y) { path.push({ type: "line", x: transform.x + x * transform.sx,
      y: transform.y + y * transform.sy }); },
    setLineDash(value) { dash = [...value]; },
    arc() {},
    fill() {},
  };
  return context;
}
const populated = {
  motor: "ARC-24 Experimental Motor",
  testDate: "2026-10-17",
  testId: "FIRE-024",
  location: "Range North",
  logger: "Load cell recorder",
  sampleRate: "50 Hz",
  camera: "High speed camera · 120 fps",
  notes: "Static test with calibrated pressure and thrust sensors.",
};
const log = () =>
  parseCSV("time_ms;thrust;pressure\n0;0;0\n100;10;2\n200;100;20\n300;0;0");

test("finite signals spanning opposite numeric extremes retain finite plot coordinates", () => {
  const data = parseCSV("time_s;thrust;pressure\n0;-1e308;0\n0.00001;1e308;1e308\n0.00002;0;0");
  for (const layout of ["full", "overlay", "stacked", "measurement"]) {
    const ctx = recordingContext(1920, 1080);
    if (layout === "measurement")
      drawMeasurementChart(ctx, 1920, 1080, data, chartPoints(data), null, { thrustUnit: "N", pressureUnit: "bar" });
    else render(ctx, { data, style: { layout }, time: 0.00001 });
    assert.ok(ctx.strokes.length > 0);
    assert.ok(ctx.strokes.every(({ points }) => points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))), layout);
    assert.ok(ctx.texts.every(({ value }) => !/Infinity|NaN/.test(value)), layout);
  }
});

const source = {
  width: 1920,
  height: 1080,
  fps: 120,
  timestamps: new Float64Array([0, 0.008, 0.025, 0.1, 0.15]),
  end: 0.2,
  videoName: "stand-camera-01.mp4",
  logName: "load-cell-log.csv",
};
const recordLabels = ["TEST ID", "LOCATION", "LOGGER", "LOG RATE", "CAMERA", "NOTES"];

function assertInside(text, box, message = text.value) {
  assert.ok(text.left >= box.x - 1e-8, `${message}: left`);
  assert.ok(text.right <= box.x + box.width + 1e-8, `${message}: right`);
  assert.ok(text.top >= box.y - 1e-8, `${message}: top`);
  assert.ok(text.bottom <= box.y + box.height + 1e-8, `${message}: bottom`);
}

function inBox(text, box) {
  return text.top >= box.y && text.bottom <= box.y + box.height;
}

function assertUncompressed(texts) {
  for (const text of texts)
    assert.ok(
      text.naturalWidth <= text.maximum + 1e-8,
      `${text.value}: canvas must not squeeze text to fit`,
    );
}

function render(
  ctx,
  {
    data = log(),
    style = {},
    metadata = populated,
    time = 0.1,
    offset = 0,
    scale = 1,
    sourceInfo = null,
    measurement = null,
    theory = null,
  } = {},
) {
  drawComposition(
    ctx,
    ctx.canvas.width,
    ctx.canvas.height,
    () => {},
    1920,
    1080,
    data,
    data ? chartPoints(data) : [],
    time,
    offset,
    scale,
    { ...defaultStyle, thrustUnit: "N", ...style },
    { ...defaultMetadata, ...metadata },
    sourceInfo,
    measurement,
    theory,
  );
  return ctx.texts;
}

test("minimum panel settings reserve positive chart and metric regions at every supported aspect", () => {
  for (const [width, height] of [
    [1920, 1080],
    [1080, 1920],
    [1080, 1080],
    [4096, 540],
    [320, 240],
  ]) {
    const style = {
      ...defaultStyle,
      height: 5,
      showPressure: true,
      showImpulse: true,
    };
    const geometry = overlayGeometry(width, height, style);
    const { chart, metrics } = geometry;
    assert.ok(chart.height > 0 && chart.width > 0, `${width} × ${height}`);
    assert.ok(chart.y > geometry.top);
    assert.ok(chart.y + chart.height < geometry.height);
    assert.ok(chart.x + chart.width + 24 < metrics.divider);
    const { thrust, pressure } = geometry.plots;
    assert.ok(thrust.height >= 45 && pressure.height >= 45);
    assert.ok(thrust.y + thrust.height < pressure.y - 20 ||
      thrust.x + thrust.width < pressure.x - 70);
    assert.equal(thrust.width, pressure.width);
    if (geometry.orientation === "vertical") assert.equal(thrust.x, pressure.x);
    else {
      assert.equal(thrust.y, pressure.y);
      assert.ok(thrust.height >= 118);
    }
    assert.equal(pressure.y + pressure.height, chart.y + chart.height);
    assert.ok(metrics.x + metrics.width < geometry.width);
    assert.ok(metrics.rowHeight >= 30);
    assert.ok(chart.y + chart.height + 24 < geometry.footer.y);
    assert.deepEqual(geometry.footer, {
      x: 0,
      y: geometry.height - 64,
      width: geometry.width,
      height: 64,
    });
    assert.ok(overlayHeight(width, height, style) <= height * 0.55 + 1e-9);
    const composition = compositionGeometry(width, height, 1920, 1080, style);
    assert.ok(
      composition.video.y + composition.video.height <=
        height - composition.panelHeight + 1e-9,
    );
  }
});

test("default Full HD reserves 1440 by 810 footage and keeps all optional elements in fixed regions", () => {
  const baseline = compositionGeometry(1920, 1080, 1920, 1080, defaultStyle);
  assert.deepEqual(baseline.video, { x: 0, y: 0, width: 1440, height: 810 });
  assert.deepEqual(baseline.info, { x: 1440, y: 0, width: 480, height: 810 });
  assert.deepEqual(baseline.sources, { x: 0, y: 1016, width: 1920, height: 64 });
  for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080], [4096, 540]]) {
    const fixed = compositionGeometry(width, height, 1920, 1080, defaultStyle);
    const plot = overlayGeometry(width, height, defaultStyle);
    for (const showPressure of [false, true]) {
      for (const showImpulse of [false, true]) {
        for (const showDetails of [false, true]) {
          const style = { ...defaultStyle, showPressure, showImpulse, showDetails };
          assert.deepEqual(compositionGeometry(width, height, 1920, 1080, style), fixed);
          const optional = overlayGeometry(width, height, style);
          assert.deepEqual(optional.chart, plot.chart);
          assert.deepEqual(optional.footer, plot.footer);
          assert.deepEqual(optional.metrics, plot.metrics);
          if (!showPressure) {
            assert.deepEqual(optional.plots.thrust, optional.chart);
            assert.equal(optional.plots.pressure, null);
          }
        }
      }
    }
  }
});

test("model, date, results, and complete test records sit beside footage while source clocks occupy the footer", () => {
  const ctx = recordingContext(1280, 720);
  const geometry = compositionGeometry(1280, 720, 1920, 1080, defaultStyle);
  const rendered = render(ctx, {
    sourceInfo: source,
    measurement: { start: 0.05, end: 0.15 },
  });
  const texts = rendered.map(({ value }) => value);
  assert.ok(texts.indexOf(populated.motor) < texts.indexOf("LIVE TOTALS"));
  assert.ok(texts.indexOf("LIVE TOTALS") < texts.indexOf("TEST RECORD"));
  for (const value of [
    "2026-10-17",
    "Frame 000004 / 5",
    "CSV row 3",
    "FIRE-024",
    "Range North",
    "50 Hz",
    source.videoName,
    source.logName,
  ])
    assert.ok(texts.includes(value), value);
  assert.ok(texts.some((value) => value.startsWith("0.100000 s · 120 fps")));
  assert.ok(texts.some((value) => value.startsWith("CSV 0.100000 s ·")));
  for (const label of recordLabels) assert.ok(texts.includes(label), label);
  for (const item of rendered.filter((item) => /^(VIDEO$|LOG$|Frame |CSV row |CSV 0\.|0\.100000 s)/.test(item.value) || [source.videoName, source.logName].includes(item.value)))
    assertInside(item, geometry.sources);
  assert.equal(texts.filter((value) => value === "Burn duration 0.100 s").length, 1);
  assert.equal(texts.filter((value) => value === "A").length, 2);
  assert.equal(texts.filter((value) => value === "B").length, 2);
  assert.ok(!texts.some((value) => /SO FAR|BURN INTERVAL|VIDEO & LOG|CSV TIME/.test(value)));
  assertUncompressed(rendered);
});

test("the sidebar exposes only observed peaks in live mode and all final results when selected", () => {
  const live = render(recordingContext(1280, 720));
  const peak = live.findIndex(({ value }) => value === "PEAK THRUST");
  assert.equal(live[peak + 1].value, "10.0 N");
  const final = render(recordingContext(1280, 720), {
    style: { summaryMode: "final" },
  });
  const finalPeak = final.findIndex(({ value }) => value === "PEAK THRUST");
  assert.equal(final[finalPeak + 1].value, "100.0 N");
  assert.ok(final.some(({ value }) => value === "FINAL RESULTS"));
  assert.ok(final.some(({ value }) => value.startsWith("CSV 0.100000 s")));
  assert.ok(!final.some(({ value }) => value === "CSV TIME"));
});

test("final sidebar results include pressure recorded after the thrust clock ends", () => {
  const data = parseCSV("force_s;force;pressure_s;pressure\n0;0;0;0\n1;10;2;20", {
    timeUnit: "s", pressureTimeUnit: "s",
    columns: { thrustTime: 0, thrust: 1, pressureTime: 2, pressure: 3 },
  });
  const live = render(recordingContext(1280, 720), { data, time: 1 });
  const livePeak = live.findIndex(({ value }) => value === "PEAK PRESSURE");
  assert.equal(live[livePeak + 1].value, "10.0 bar");
  const final = render(recordingContext(1280, 720), { data, time: 1,
    style: { summaryMode: "final" } });
  const finalPeak = final.findIndex(({ value }) => value === "PEAK PRESSURE");
  assert.equal(final[finalPeak + 1].value, "20.0 bar");
  assert.ok(final.some(({ value }) => value === "FINAL RESULTS"));
  assert.ok(!final.some(({ value }) => value === "LIVE TOTALS"));
});

test("different video and logger clocks show frame diagnostics without inventing rows outside the log", () => {
  const sourceInfo = {
    width: 1920,
    height: 1080,
    fps: 60,
    timestamps: new Float64Array([0, 0.008, 0.025, 0.058]),
    end: 0.1,
  };
  const before = render(recordingContext(1280, 720), {
    sourceInfo,
    time: 0.04,
    offset: 1e9,
  });
  assert.ok(before.some(({ value }) => value === "Frame 000003 / 4"));
  assert.ok(before.some(({ value }) => value === "CSV row — · awaiting data"));
  assert.ok(!before.some(({ value }) => /NaN|Infinity/.test(value)));
  const after = render(recordingContext(1280, 720), {
    sourceInfo,
    time: 0.04,
    offset: -1e9,
  });
  assert.ok(after.some(({ value }) => value === "CSV row — · complete"));
});

test("long metadata remains inside safe sidebar margins without moving the video or plot", () => {
  for (const [width, height] of [
    [1920, 1080],
    [1280, 720],
    [1080, 1920],
    [4096, 540],
  ]) {
    const style = { ...defaultStyle, height: 5, showImpulse: true };
    const baseline = compositionGeometry(width, height, 1920, 1080, style);
    const ctx = recordingContext(width, height);
    const metadata = Object.fromEntries(
      Object.keys(populated).map((key) => [
        key,
        key === "testDate"
          ? "2026-10-17"
          : `${key}: ${"A detailed test record ".repeat(15)}`,
      ]),
    );
    const sourceInfo = {
      width: 1920,
      height: 1080,
      fps: 120,
      timestamps: new Float64Array([0, 0.1, 0.2]),
      end: 0.3,
      videoName: `camera-${"long_test_record_".repeat(20)}.mp4`,
      logName: `telemetry-${"long_test_record_".repeat(20)}.csv`,
    };
    const texts = render(ctx, { metadata, sourceInfo, style });
    const side = texts.filter((text) => text.left >= baseline.info.x && text.bottom <= baseline.info.height);
    const footer = texts.filter((text) => inBox(text, baseline.sources));
    assert.ok(footer.some(({ value }) => value.startsWith("Frame ")));
    assert.ok(footer.some(({ value }) => value.startsWith("CSV row ")));
    assert.ok(side.some(({ value }) => value === "2026-10-17"));
    for (const label of recordLabels) {
      const heading = side.find(({ value }) => value === label);
      assert.ok(heading, label);
      assert.ok(side.some((text) => text.left > heading.right && Math.abs(text.bottom - heading.bottom) < 8), `${label}: missing value`);
    }
    for (const text of side) {
      assert.ok(text.left > baseline.info.x, text.value);
      assert.ok(text.right < width, text.value);
      assertInside(text, baseline.info);
    }
    for (const item of footer) assertInside(item, baseline.sources);
    assertUncompressed(texts);
    assert.deepEqual(
      compositionGeometry(width, height, 1920, 1080, style),
      baseline,
    );
  }
});

test("maximum-length test fields all remain visible at readable sizes without canvas compression", () => {
  const fields = [
    ["testId", "TEST ID", 60],
    ["location", "LOCATION", 80],
    ["logger", "LOGGER", 100],
    ["sampleRate", "LOG RATE", 50],
    ["camera", "CAMERA", 100],
    ["notes", "NOTES", 240],
  ];
  const metadata = {
    motor: "ARC-24 Experimental High Performance Development Motor / Serial 000042",
    testDate: "2026-10-17",
    ...Object.fromEntries(fields.map(([key, , length]) => [key, `${key} ${"record conditions ".repeat(20)}`.slice(0, length)])),
  };
  for (const [width, height, panelHeight] of [[1920, 1080, 25], [4096, 540, 25], [4096, 540, 48], [4096, 540, 55]]) {
    const style = { ...defaultStyle, height: panelHeight };
    const geometry = compositionGeometry(width, height, 1920, 1080, style);
    const texts = render(recordingContext(width, height), { metadata, sourceInfo: source, style });
    const side = texts.filter((text) => text.left > geometry.info.x && text.bottom < geometry.info.height);
    const model = side.filter((text) => text.size / presentationScale(width, height) >= 26);
    assert.equal(model.length, 2, "The motor model retains its two-line allocation");
    for (const [key, label] of fields) {
      const heading = side.find(({ value }) => value === label);
      assert.ok(heading, label);
      const values = side.filter((text) => text.left > heading.right && text.top >= heading.top - 4 && text.value.startsWith(key));
      assert.equal(values.length, 1, `${label}: populated field must remain visible`);
      const value = values[0];
      const nominalSize = value.size / presentationScale(width, height);
      assert.ok(nominalSize >= (width === 1920 ? 16 : 12), `${label}: ${nominalSize}px`);
      assert.ok(nominalSize <= 18);
    }
    for (const text of side) assertInside(text, geometry.info);
    assertUncompressed(texts);
  }
});

test("metadata wrapping is cached while source-frame and live-value updates remain current", () => {
  const ctx = recordingContext(1280, 720);
  const metadata = {
    ...populated,
    notes: "Detailed recording conditions ".repeat(30),
  };
  render(ctx, { metadata, time: 0.1, sourceInfo: source });
  const initialMeasurements = ctx.measurements;
  ctx.measurements = 0;
  ctx.texts.length = 0;
  render(ctx, { metadata, time: 0.2, sourceInfo: source });
  assert.ok(ctx.measurements < initialMeasurements / 2);
  const peak = ctx.texts.findIndex(({ value }) => value === "PEAK THRUST");
  assert.equal(ctx.texts[peak + 1].value, "100.0 N");
  assert.ok(ctx.texts.some(({ value }) => value === "Frame 000005 / 5"));
  assert.ok(ctx.texts.some(({ value }) => value === "CSV row 4"));
  ctx.texts.length = 0;
  render(ctx, {
    metadata,
    time: 0.2,
    sourceInfo: { ...source, videoName: "replacement-camera.mp4", timestamps: new Float64Array([0, 0.1, 0.2]), end: 0.3 },
  });
  assert.ok(ctx.texts.some(({ value }) => value === "Frame 000003 / 3"));
  assert.ok(ctx.texts.some(({ value }) => value === "replacement-camera.mp4"));
});

test("primary values and optional impulse stay above the full-width source footer at minimum height", () => {
  for (const [width, height] of [
    [1280, 720],
    [1080, 1920],
    [4096, 540],
  ]) {
    const ctx = recordingContext(width, height);
    const style = { ...defaultStyle, height: 5, showPressure: true, showImpulse: true };
    const geometry = compositionGeometry(width, height, 1920, 1080, style);
    const texts = render(ctx, {
      style: { height: 5, showPressure: true, showImpulse: true },
      sourceInfo: source,
    });
    let previous = null;
    for (const label of ["THRUST", "PRESSURE"]) {
      const index = texts.findIndex(({ value }) => value === label);
      const heading = texts[index];
      const value = texts[index + 2];
      assert.ok(value.top > heading.bottom, `${label}: value covers its label`);
      if (previous)
        assert.ok(
          heading.top > previous.bottom,
          `${label}: preceding value covers label`,
        );
      previous = value;
    }
    for (const label of ["IMPULSE"]) {
      const index = texts.findIndex(({ value }) => value === label);
      const heading = texts[index];
      const value = texts[index + 1];
      assert.ok(heading.right < value.left, `${label}: value covers label`);
      assert.ok(heading.top > previous.bottom, `${label}: preceding row overlaps`);
      assert.ok(value.bottom < geometry.sources.y, `${label}: value overlaps source footer`);
      previous = value;
    }
    assert.ok(!texts.some(({ value }) => value === "CSV TIME"));
    const footer = texts.filter((text) => inBox(text, geometry.sources));
    for (const text of footer) assertInside(text, geometry.sources);
    assertUncompressed(texts);
  }
});

test("rounded axes cover positive, negative, zero, and converted sensor ranges", () => {
  for (const [minimum, maximum] of [
    [0, 457.2],
    [-15.6, 121],
    [-100, -10],
    [0, 0],
    [0, 0.000023],
    [0, 456000],
  ]) {
    const axis = chartAxis(minimum, maximum);
    assert.ok(axis.min <= minimum);
    assert.ok(axis.max >= maximum && axis.max > axis.min);
    assert.ok(axis.ticks.length >= 2 && axis.ticks.length <= 5);
    assert.equal(axis.ticks[0], axis.min);
    assert.ok(
      Math.abs(axis.ticks.at(-1) - axis.max) < (axis.max - axis.min) * 1e-12,
    );
    assert.ok(axis.ticks.every(Number.isFinite));
  }
});

test("filenames retain source identity without shrinking diagnostics or showing empty placeholders", () => {
  const sourceInfo = {
    width: 832,
    height: 464,
    fps: 60,
    timestamps: new Float64Array([0, 0.1, 0.2]),
    end: 0.3,
    videoName: "stand-camera-01.mp4",
    logName: "load-cell-log.csv",
  };
  for (const [width, height] of [
    [832, 468],
    [1920, 1080],
    [1080, 1920],
    [4096, 540],
  ]) {
    const baseline = render(recordingContext(width, height), {
      sourceInfo,
      metadata: defaultMetadata,
    });
    for (const name of [sourceInfo.videoName, sourceInfo.logName])
      assert.equal(baseline.filter(({ value }) => value === name).length, 1);
    assert.ok(
      !baseline.some(
        ({ value }) => value === "MOTOR MODEL" || value === "TEST RECORD",
      ),
    );
    const namedMotor = render(recordingContext(width, height), {
      sourceInfo,
      metadata: { motor: "ARC-24 / DEVELOPMENT" },
      style: { height: 5, showImpulse: true },
    });
    assert.ok(namedMotor.some(({ value }) => value.includes("DEVELOPMENT")));

    const ctx = recordingContext(width, height);
    const long = render(ctx, {
      metadata: defaultMetadata,
      sourceInfo: {
        ...sourceInfo,
        videoName: `Відео-${"довга_назва_".repeat(40)}.mp4`,
        logName: `Лог-${"довга_назва_".repeat(40)}.csv`,
      },
    });
    assert.ok(long.some(({ value }) => value.startsWith("Відео-")));
    assert.ok(long.some(({ value }) => value.endsWith(".mp4")));
    assert.ok(long.some(({ value }) => value.startsWith("Лог-")));
    assert.ok(long.some(({ value }) => value.endsWith(".csv")));
    const frame = long.find(({ value }) => value.startsWith("Frame "));
    assert.equal(
      frame.size,
      baseline.find(({ value }) => value.startsWith("Frame ")).size,
    );
    const geometry = compositionGeometry(width, height, 1920, 1080, defaultStyle);
    const footer = long.filter((text) => inBox(text, geometry.sources));
    for (const value of ["VIDEO", "LOG"])
      assert.ok(footer.some((item) => item.value === value), value);
    for (const item of footer) assertInside(item, geometry.sources);
    assertUncompressed(long);
  }
});

test("default video graphics display kilogram-force and bar on separate signal axes", () => {
  assert.equal(defaultStyle.thrustUnit, "kgf");
  assert.equal(defaultStyle.pressureUnit, "bar");
  const data = parseCSV("time_ms;thrust;pressure\n0;9.80665;2\n100;9.80665;2");
  const ctx = recordingContext(1920, 1080);
  drawOverlay(ctx, 1920, 1080, data, chartPoints(data), 0.05, 0, 1, defaultStyle);
  const thrust = ctx.texts.find(({ value }) => value === "Thrust · kgf");
  const pressure = ctx.texts.find(({ value }) => value === "Pressure · bar");
  assert.ok(thrust && pressure);
  assert.ok(thrust.bottom < pressure.top || thrust.right < pressure.left);
  const instant = ctx.texts.findIndex(({ value }) => value === "THRUST");
  assert.equal(ctx.texts[instant + 1].value, "kgf");
  assert.equal(ctx.texts[instant + 2].value, "1.0");
  assert.ok(ctx.texts.some(({ value }) => value === "Time"));
});

test("theory uses its own clock, extends both plot axes, and preserves telemetry gaps", () => {
  const data = log();
  const calculated = parseCSV("time_ms;thrust;pressure\n10000;-50;-3\n10100;2000;100\n11000;1200;70\n11100;0;0");
  const theory = { data: calculated, reduced: chartPoints(calculated), offset: -10,
    timeScale: 1, name: "theoretical.csv" };
  const domain = overlayTimeDomain(data, theory);
  assert.equal(domain.start, 0);
  assert.ok(Math.abs(domain.end - 1.1) < 1e-12);
  const ctx = recordingContext(1920, 1080);
  render(ctx, { data, theory });
  assert.ok(ctx.texts.some(({ value }) => value === "Measured"));
  assert.ok(ctx.texts.some(({ value }) => value === "Theory"));
  const curves = ctx.strokes.filter(({ points, dash }) =>
    dash.join(",") === "6,3" && points.length > 2);
  assert.equal(curves.length, 2);
  const geometry = overlayGeometry(1920, 1080, defaultStyle);
  for (let i = 0; i < curves.length; i++) {
    const box = geometry.plots[i ? "pressure" : "thrust"];
    const { points } = curves[i];
    assert.deepEqual(points.map(({ type }) => type), ["move", "line", "move", "line"]);
    assert.ok(Math.abs(points[0].x - box.x) < 1e-10);
    assert.ok(Math.abs(points.at(-1).x - box.x - box.width) < 1e-10);
    for (const point of points) {
      assert.ok(point.y >= box.y && point.y <= box.y + box.height);
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    }
  }
  assert.ok(ctx.texts.some(({ value }) => value === "4000"), "theory peak contributes to thrust scale");
  assert.ok(ctx.texts.some(({ value }) => value === "200"), "theory peak contributes to pressure scale");
});

test("A/B mark both plots and burn duration retains original CSV seconds after slow-motion alignment", () => {
  for (const showPressure of [false, true]) {
    const ctx = recordingContext(1920, 1080);
    render(ctx, { time: 0.2, scale: 2, measurement: { start: 0.05, end: 0.15 },
      style: { showPressure } });
    const count = showPressure ? 2 : 1;
    assert.equal(ctx.texts.filter(({ value }) => value === "A").length, count);
    assert.equal(ctx.texts.filter(({ value }) => value === "B").length, count);
    assert.equal(ctx.texts.filter(({ value }) => value === "Burn duration 0.100 s").length, 1);
    assert.ok(ctx.texts.some(({ value }) => value.includes("TIME STRETCH 200%")));
    assertUncompressed(ctx.texts);
  }
});

test("preview composition and direct export overlay draw identical measured and theoretical curves", () => {
  const data = log();
  const calculated = parseCSV("time_ms;thrust;pressure\n1000;0;0\n1100;90;25\n1200;40;10\n1300;0;0");
  const theory = { data: calculated, reduced: chartPoints(calculated), offset: -1,
    timeScale: 1, name: "calculated.csv" };
  const composed = recordingContext(1920, 1080);
  render(composed, { data, theory, measurement: { start: 0.05, end: 0.15 } });
  const overlay = recordingContext(1920, 1080);
  drawOverlay(overlay, 1920, 1080, data, chartPoints(data), 0.1, 0, 1,
    { ...defaultStyle, thrustUnit: "N", opacity: 100 },
    { start: 0.05, end: 0.15 }, theory);
  const curves = ({ strokes }) => strokes.filter(({ points, lineWidth }) =>
    points.length > 2 && [2, 2.4].includes(lineWidth));
  assert.deepEqual(curves(composed), curves(overlay));
  assert.equal(curves(composed).length, 6);
});

test("nonzero source clocks fit both plot edges without covering the shared time caption", () => {
  const data = parseCSV("time_ms;thrust;pressure\n10000000;0;0\n10000100;100;2\n10000200;0;0");
  const ctx = recordingContext(1920, 1080);
  render(ctx, { data, time: 10000.1 });
  const geometry = overlayGeometry(1920, 1080, defaultStyle);
  const captions = ctx.texts.filter(({ value }) => value === "Time");
  const starts = ctx.texts.filter(({ value }) => value === "10000 s");
  const ends = ctx.texts.filter(({ value }) => value === "10000.2 s");
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  for (let index = 0; index < 2; index++) {
    const box = geometry.plots[index ? "pressure" : "thrust"];
    assert.ok(captions[index].right < starts[index].left);
    assert.ok(starts[index].left >= box.x);
    assert.ok(ends[index].right <= box.x + box.width);
  }
});

test("on-video template keeps uncropped footage fixed and gives both signals tall independent plots", () => {
  for (const [width, height, sourceWidth, sourceHeight] of [
    [1920, 1080, 832, 464],
    [1080, 1920, 1080, 1920],
    [1080, 1080, 640, 480],
    [4096, 540, 1920, 1080],
    [320, 240, 1920, 1080],
  ]) {
    const style = { ...defaultStyle, layout: "stacked" };
    const fixed = compositionGeometry(width, height, sourceWidth, sourceHeight, style);
    assert.equal(fixed.info, null);
    assert.equal(fixed.panelHeight, 0);
    assert.ok(Math.abs(fixed.video.width / fixed.video.height - sourceWidth / sourceHeight) < 1e-10);
    assert.ok(fixed.video.y + fixed.video.height <= fixed.sources.y + 1e-8);
    assert.ok(fixed.video.x >= 0 && fixed.video.x + fixed.video.width <= width + 1e-8);
    const geometry = overlayGeometry(width, height, style);
    assert.equal(geometry.orientation, "vertical");
    assert.ok(geometry.plots.thrust.height > 200);
    assert.equal(geometry.plots.pressure.y - geometry.plots.thrust.y - geometry.plots.thrust.height, 64);
    assert.ok(geometry.plots.pressure.y + geometry.plots.pressure.height + 24 < geometry.footer.y);
    for (const showPressure of [false, true]) {
      const option = { ...style, showPressure, showDetails: false, showImpulse: true };
      assert.deepEqual(compositionGeometry(width, height, sourceWidth, sourceHeight, option), fixed);
      const changed = overlayGeometry(width, height, option);
      assert.deepEqual(changed.panel, geometry.panel);
      if (!showPressure) {
        assert.equal(changed.plots.pressure, null);
        assert.deepEqual(changed.plots.thrust, changed.chart);
      }
    }
  }
});

test("on-video source clocks occupy the top header while metadata and all filenames keep distinct regions", () => {
  const calculated = parseCSV("time_ms;thrust;pressure\n0;0;0\n100;100;20\n200;0;0");
  const theory = { data: calculated, reduced: chartPoints(calculated), offset: 0,
    timeScale: 1, name: "calculated-profile.csv" };
  for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080], [4096, 540]]) {
    const style = { ...defaultStyle, layout: "stacked", showImpulse: true };
    const geometry = compositionGeometry(width, height, 1920, 1080, style);
    const ctx = recordingContext(width, height);
    const texts = render(ctx, {
      style,
      sourceInfo: source,
      theory,
      scale: 2,
      time: 0.2,
      measurement: { start: 0.05, end: 0.15 },
    });
    for (const name of [source.videoName, source.logName, theory.name]) {
      const text = texts.find(({ value }) => value === name);
      assert.ok(text, name);
      assertInside(text, geometry.sources);
    }
    const footerLabels = ["VIDEO", "LOG", "THEORY"];
    for (const label of footerLabels)
      assertInside(texts.find(({ value }) => value === label), geometry.sources);
    const model = texts.filter((text) => Math.abs(text.size / presentationScale(width, height) - 29) < 1e-8);
    assert.equal(model.map(({ value }) => value).join(" "), populated.motor);
    for (const text of model) {
      assert.ok(text.bottom < geometry.sources.y, text.value);
      assert.ok(text.top >= geometry.videoFrame.y, text.value);
    }
    for (const value of [populated.testDate, "PEAK THRUST", "PEAK PRESSURE",
      "TOTAL IMPULSE", ...recordLabels]) {
      const text = texts.find((item) => item.value === value);
      assert.ok(text, value);
      assert.ok(text.bottom < geometry.sources.y, value);
      assert.ok(text.top >= geometry.videoFrame.y, value);
    }
    for (const value of ["Frame 000005 / 5 · 0.150000 s", "Log row 3 · 0.100000 s",
      "1920 × 1080 · 120 fps · 10.0 Hz avg"]) {
      const clock = texts.filter((item) => item.value === value);
      assert.equal(clock.length, 1, value);
      assertInside(clock[0], geometry.header);
    }
    const headerTexts = texts.filter((item) => inBox(item, geometry.header));
    assert.equal(headerTexts.length, 3);
    assert.ok(!headerTexts.some(({ value }) => /CSV|VIDEO FRAME|ACQUISITION|PTS|Δ/.test(value)));
    const scale = presentationScale(width, height);
    const narrow = width / scale < 1400;
    assert.equal(geometry.header.height, (narrow ? 74 : 42) * scale);
    assert.equal(new Set(headerTexts.map(({ bottom, size }) => Math.round((bottom - size * 0.2) * 1e6))).size, narrow ? 2 : 1);
    for (let index = 1; index < (narrow ? 2 : 3); index++)
      assert.ok(headerTexts[index].left - headerTexts[index - 1].right >= 12 * scale);
    assert.equal(texts.filter(({ value }) => value === "A").length, 2);
    assert.equal(texts.filter(({ value }) => value === "B").length, 2);
    assert.ok(texts.some(({ value }) => value === "Burn duration 0.100 s"));
    assert.ok(texts.some(({ value }) => value.includes("TIME STRETCH 200%")));
    assert.equal(ctx.strokes.filter(({ dash, points, color }) => color === "#f3d05c" && dash.join(",") === "6,3" && points.length > 2).length, 2);
    for (const text of texts) assertInside(text, { x: 0, y: 0, width, height });
    assertUncompressed(texts);
  }
});

test("hiding A/B annotations retains the burn-focused plot domain in every template", () => {
  for (const layout of ["full", "overlay", "stacked"]) {
    const measurement = { start: 0.05, end: 0.15 };
    const shown = recordingContext(1920, 1080);
    render(shown, { style: { layout }, measurement });
    const hidden = recordingContext(1920, 1080);
    render(hidden, { style: { layout }, measurement: { ...measurement, visible: false } });
    assert.ok(!hidden.texts.some(({ value }) => value === "A" || value === "B" || value.startsWith("Burn duration")));
    const timeLabels = ({ texts }) => texts.filter(({ value }) => /^-?[\d.]+ s$/.test(value)).map(({ value }) => value);
    assert.deepEqual(timeLabels(hidden), timeLabels(shown));
  }
});

test("on-video panels keep dark translucent backdrops and full-contrast text on bright footage", () => {
  for (const [opacity, expected] of [[0, 0], [25, 0.25], [78, 0.78], [100, 0.95]]) {
    const ctx = recordingContext(1920, 1080);
    const style = { ...defaultStyle, layout: "stacked", theme: "light", opacity };
    render(ctx, { style, sourceInfo: source });
    const { panel } = overlayGeometry(1920, 1080, style);
    const backdrop = ctx.fills.find((box) => box.x === panel.x && box.y === panel.y && box.width === panel.width);
    assert.equal(backdrop.color, `rgba(10,18,25,${expected})`);
    assert.ok(!ctx.fills.some(({ color }) => /rgba\(246,248,250/.test(color)));
    assert.ok(ctx.strokes.some(({ color }) => color === "#e9a56c"));
    assert.ok(ctx.strokes.some(({ color, lineWidth }) => color === "#071018" && lineWidth > 2.4));
    const model = ctx.texts.filter(({ size }) => size === 29);
    assert.equal(model.map(({ value }) => value).join(" "), populated.motor);
    for (const label of ["Thrust · kgf", "Frame 000004 / 5 · 0.100000 s", ...model.map(({ value }) => value)])
      assert.ok(ctx.outlines.some(({ value, width, shadow }) => value === label && width >= 3 && shadow > 0), label);
    assert.ok(ctx.texts.every(({ alpha }) => alpha === 1));
    assert.ok(!ctx.texts.some(({ value }) => value === "TELEMETRY"));
    assert.equal(ctx.texts.filter(({ value }) => value === "Time").length, 1);
    assertUncompressed(ctx.texts);
  }
});

test("on-video thrust-only mode uses the complete plot area and retains synchronized source clocks", () => {
  const ctx = recordingContext(1920, 1080);
  const style = { layout: "stacked", showPressure: false, showDetails: false, showImpulse: true };
  const texts = render(ctx, { style, sourceInfo: source, time: 0.1,
    measurement: { start: 0.05, end: 0.15 } });
  assert.equal(texts.filter(({ value }) => value === "Time").length, 1);
  assert.equal(texts.filter(({ value }) => value === "A").length, 1);
  assert.ok(texts.some(({ value }) => value === "Frame 000004 / 5 · 0.100000 s"));
  assert.ok(texts.some(({ value }) => value === "Log row 3 · 0.100000 s"));
  assert.ok(!texts.some(({ value }) => /Pressure|PEAK|TOTAL IMPULSE/.test(value)));
  assert.ok(!texts.some(({ value }) => value === populated.motor));
  assert.ok(texts.some(({ value }) => value === "IMPULSE SO FAR"));
  assertUncompressed(texts);
});

test("zoomed and repositioned footage is clipped between the technical header and filename footer", () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920]]) {
    const style = { ...defaultStyle, layout: "stacked", videoScale: 175, videoX: -35, videoY: 25 };
    const geometry = compositionGeometry(width, height, 1920, 1080, style);
    const ctx = recordingContext(width, height);
    let painted;
    drawComposition(ctx, width, height, (_ctx, x, y, width, height) => {
      painted = { x, y, width, height };
      assert.deepEqual(ctx.clips[0], geometry.videoFrame);
    }, 1920, 1080, null, [], 0, 0, 1, style, defaultMetadata, source);
    assert.deepEqual(painted, geometry.video);
    assert.equal(geometry.videoFrame.y, geometry.header.y + geometry.header.height);
    assert.ok(Math.abs(geometry.videoFrame.y + geometry.videoFrame.height - geometry.sources.y) < 1e-8);
    assert.ok(geometry.video.x < geometry.videoFrame.x || geometry.video.y < geometry.videoFrame.y ||
      geometry.video.x + geometry.video.width > geometry.videoFrame.x + geometry.videoFrame.width ||
      geometry.video.y + geometry.video.height > geometry.videoFrame.y + geometry.videoFrame.height);
    for (const text of ctx.texts.filter(({ value }) => value.startsWith("Frame ") || value.startsWith("Log row ")))
      assertInside(text, geometry.header);
  }
});

test("compact header preserves native frame timestamps independently of log alignment", () => {
  const ctx = recordingContext(1920, 1080);
  const texts = render(ctx, { style: { layout: "stacked", showDetails: false },
    sourceInfo: { ...source, variable: true }, time: 0.025, offset: -0.375, scale: 4 });
  const header = compositionGeometry(1920, 1080, 1920, 1080,
    { ...defaultStyle, layout: "stacked" }).header;
  for (const value of ["Frame 000003 / 5 · 0.025000 s", "Log row 3 · 0.100000 s",
    "1920 × 1080 · 120 fps · VFR · 10.0 Hz avg"]) {
    const text = texts.find((item) => item.value === value);
    assert.ok(text, value);
    assertInside(text, header);
  }
});

function physicalRect(box, scale) {
  return { x: box.x * scale, y: box.y * scale,
    width: box.width * scale, height: box.height * scale };
}

function textsInRect(texts, box) {
  return texts.filter((text) => text.left >= box.x - 1e-8 &&
    text.right <= box.x + box.width + 1e-8 && inBox(text, box));
}

function stackedRegions(width, height, style = {}) {
  const geometry = overlayGeometry(width, height, { ...defaultStyle, layout: "stacked", ...style });
  return {
    geometry,
    left: physicalRect({ x: geometry.cards.x, y: geometry.cards.top,
      width: geometry.cards.width, height: geometry.cards.bottom - geometry.cards.top }, geometry.scale),
    panel: physicalRect(geometry.panel, geometry.scale),
    plots: Object.fromEntries(Object.entries(geometry.plots)
      .filter(([, box]) => box).map(([key, box]) => [key, physicalRect(box, geometry.scale)])),
  };
}

function followingValue(texts, label) {
  const index = texts.findIndex(({ value }) => value === label);
  assert.ok(index >= 0, `Missing metric label: ${label}`);
  assert.ok(index + 1 < texts.length, `Missing value for ${label}`);
  return texts[index + 1].value;
}

function assertNoTextOverlap(texts, message) {
  for (let first = 0; first < texts.length; first++) {
    for (let second = first + 1; second < texts.length; second++) {
      const a = texts[first], b = texts[second];
      const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      assert.ok(horizontal <= 1e-8 || vertical <= 1e-8,
        `${message}: ${JSON.stringify(a.value)} overlaps ${JSON.stringify(b.value)}`);
    }
  }
}

test("a valid pressure-only part of a custom log is not labelled awaiting or complete", () => {
  const data = parseCSV("force_s;load;pressure_s;bar\n1;0;0;1\n1.5;10;1;2\n2;0;3;3", {
    timeUnit: "s", pressureTimeUnit: "s", columns: { thrustTime: 0, thrust: 1, pressureTime: 2, pressure: 3 },
  });
  for (const time of [.5, 2.5]) {
    const texts = render(recordingContext(1920, 1080), { data, time,
      style: { layout: "stacked", chartRange: "full" } });
    assert.ok(!texts.some(({ value }) => /AWAITING DATA|TEST COMPLETE/.test(value)));
    assert.ok(!texts.some(({ value }) => /NaN|Infinity/.test(value)));
  }
});

test("stacked totals remain live while complete-log results occupy the graph header without an impulse footer", () => {
  const { left, panel, plots } = stackedRegions(1920, 1080);
  for (const summaryMode of ["live", "final"]) {
    const expected = [
      { time: 0.1, thrust: "10.0 N", pressure: "2.0 bar", impulse: "0.5 N·s" },
      { time: 0.2, thrust: "100.0 N", pressure: "20.0 bar", impulse: "6.0 N·s" },
      { time: 0.4, thrust: "100.0 N", pressure: "20.0 bar", impulse: "11.0 N·s" },
    ];
    for (const point of expected) {
      const texts = render(recordingContext(1920, 1080), {
        style: { layout: "stacked", summaryMode, showImpulse: true }, time: point.time,
        measurement: { start: 0.05, end: 0.15 },
      });
      const live = textsInRect(texts, left);
      const results = textsInRect(texts, panel).filter((text) => text.bottom < plots.thrust.y);
      assert.equal(live.filter(({ value }) => value === "LIVE TOTALS").length, 1);
      assert.equal(followingValue(live, "PEAK THRUST"), point.thrust);
      assert.equal(followingValue(live, "PEAK PRESSURE"), point.pressure);
      assert.equal(followingValue(live, "IMPULSE SO FAR"), point.impulse);
      assert.ok(!live.some(({ value }) => value === "FINAL RESULTS" || value === "TOTAL IMPULSE"));
      assert.equal(results.filter(({ value }) => value === "FINAL RESULTS").length, 1);
      assert.equal(followingValue(results, "PEAK THRUST"), "100.0 N");
      assert.equal(followingValue(results, "PEAK PRESSURE"), "20.0 bar");
      assert.equal(followingValue(results, "TOTAL IMPULSE"), "11.0 N·s");
      assert.equal(texts.filter(({ value }) => value === "TOTAL IMPULSE").length, 1);
      assert.equal(texts.filter(({ value }) => value === "IMPULSE SO FAR").length, 1);
      assert.ok(!texts.some(({ value }) => value === "IMPULSE"));
      assert.equal(texts.filter(({ value }) => value === "Burn duration 0.100 s").length, 1);
      for (const text of results) assertInside(text, panel);
      assertNoTextOverlap(results, "Graph results header");
      assertUncompressed(texts);
    }
  }
});

test("stacked live totals show pending, gaps, completion, and rewind without leaking future peaks", () => {
  const data = parseCSV("time_ms;thrust;pressure\n0;0;0\n100;10;2\n200;20;4\n2000;100;20\n2100;0;0");
  assert.equal(data.gaps, 1);
  const { left, panel, plots } = stackedRegions(1920, 1080);
  const ctx = recordingContext(1920, 1080);
  const cases = [
    { time: -0.1, state: "WAITING", thrust: "0.0 N", pressure: "0.0 bar", impulse: "0.0 N·s" },
    { time: 1, state: "DATA GAP", thrust: "20.0 N", pressure: "4.0 bar", impulse: "2.0 N·s" },
    { time: 2.2, state: "COMPLETE", thrust: "100.0 N", pressure: "20.0 bar", impulse: "7.0 N·s" },
    { time: 0.1, state: "ACTIVE", thrust: "10.0 N", pressure: "2.0 bar", impulse: "0.5 N·s" },
  ];
  for (const point of cases) {
    ctx.texts.length = 0;
    const texts = render(ctx, { data, time: point.time,
      style: { layout: "stacked", summaryMode: "final" } });
    const live = textsInRect(texts, left);
    const final = textsInRect(texts, panel).filter((text) => text.bottom < plots.thrust.y);
    assert.ok(live.some(({ value }) => value === "LIVE TOTALS"));
    assert.ok(live.some(({ value }) => value === point.state), point.state);
    assert.equal(followingValue(live, "PEAK THRUST"), point.thrust);
    assert.equal(followingValue(live, "PEAK PRESSURE"), point.pressure);
    assert.equal(followingValue(live, "IMPULSE SO FAR"), point.impulse);
    assert.equal(followingValue(final, "PEAK THRUST"), "100.0 N");
    assert.equal(followingValue(final, "TOTAL IMPULSE"), "7.0 N·s");
    assert.ok(!texts.some(({ value }) => /NaN|Infinity/.test(value)));
    assertNoTextOverlap(live, `${point.state} live card`);
  }
});

test("stacked visibility controls never duplicate impulse or leave empty result headings", () => {
  for (const showDetails of [false, true]) {
    for (const showPressure of [false, true]) {
      for (const showImpulse of [false, true]) {
        const style = { layout: "stacked", showDetails, showPressure, showImpulse };
        const { panel, plots } = stackedRegions(1920, 1080, style);
        const texts = render(recordingContext(1920, 1080), { style });
        assert.equal(texts.filter(({ value }) => value === "FINAL RESULTS").length, Number(showDetails));
        assert.equal(texts.filter(({ value }) => value === "LIVE TOTALS").length, Number(showDetails));
        assert.equal(texts.filter(({ value }) => value === "TOTAL IMPULSE").length, Number(showDetails));
        assert.equal(texts.filter(({ value }) => value === "IMPULSE SO FAR").length,
          Number(showDetails || showImpulse));
        assert.equal(texts.filter(({ value }) => value === "PEAK PRESSURE").length,
          showDetails && showPressure ? 2 : 0);
        assert.equal(texts.filter(({ value }) => value === "Pressure · bar").length, Number(showPressure));
        assert.ok(!texts.some(({ value }) => value === "IMPULSE"));
        if (!showDetails) {
          assert.ok(!texts.some(({ value }) => recordLabels.includes(value) ||
            value === populated.motor || value === populated.testDate));
          if (showImpulse) {
            const compact = texts.find(({ value }) => value === "IMPULSE SO FAR");
            assertInside(compact, panel);
            assert.ok(compact.bottom < plots.thrust.y, "The sole live impulse belongs to the graph header");
          }
        }
        assertUncompressed(texts);
      }
    }
  }
  const empty = render(recordingContext(1920, 1080), {
    data: null, style: { layout: "stacked" },
  });
  assert.ok(!empty.some(({ value }) => value === "FINAL RESULTS" || value === "LIVE TOTALS" ||
    value === "TOTAL IMPULSE" || value === "IMPULSE SO FAR"));
});

test("stacked final results use display units and original logger integration after time stretch", () => {
  const { left, panel, plots } = stackedRegions(1920, 1080);
  for (const [offset, scale, time] of [[0, 1, 0.1], [3, 2, 3.2], [-2, 0.5, -1.95]]) {
    const texts = render(recordingContext(1920, 1080), {
      time, offset, scale, measurement: { start: 0.05, end: 0.15 },
      style: { layout: "stacked", thrustUnit: "lbf", pressureUnit: "kPa", summaryMode: "final" },
    });
    const live = textsInRect(texts, left);
    const final = textsInRect(texts, panel).filter((text) => text.bottom < plots.thrust.y);
    assert.equal(followingValue(live, "PEAK THRUST"), "2.25 lbf");
    assert.equal(followingValue(live, "PEAK PRESSURE"), "200.0 kPa");
    assert.equal(followingValue(live, "IMPULSE SO FAR"), "0.112 lbf·s");
    assert.equal(followingValue(final, "PEAK THRUST"), "22.5 lbf");
    assert.equal(followingValue(final, "PEAK PRESSURE"), "2,000.0 kPa");
    assert.equal(followingValue(final, "TOTAL IMPULSE"), "2.47 lbf·s");
    assert.equal(texts.filter(({ value }) => value === "Burn duration 0.100 s").length, 1);
    assertUncompressed(texts);
  }
});

test("narrow stacked metadata wraps vertically without covering live totals or source strips", () => {
  const metadata = {
    motor: "ARC-24 Experimental Development Motor",
    testDate: "2026-10-17",
    testId: "BATCH-024 / Serial 000042",
    location: "North range / test area A1",
    logger: "Calibrated thrust and pressure logger v2.1.2",
    sampleRate: "50 Hz / acquisition interval 20 ms",
    camera: "High speed camera / 1920 × 1080 at 120 fps",
    notes: "Propellant lot AL-20. Calibrated load cell and chamber pressure sensors. Ambient temperature 18 °C. Static stand inspection completed before recording.",
  };
  for (const [width, height] of [[1920, 1080], [1080, 1920], [4096, 540]]) {
    const { geometry, left, panel } = stackedRegions(width, height);
    assert.ok(geometry.cards.width <= 392, "Metadata cards keep a narrow footprint");
    assert.ok(left.x + left.width + 24 * geometry.scale <= panel.x,
      "Cards leave open video between metadata and the graphs");
    const texts = render(recordingContext(width, height), {
      metadata, sourceInfo: source, style: { layout: "stacked", summaryMode: "final" },
    });
    const cardTexts = textsInRect(texts, left);
    for (const value of ["2026-10-17", ...recordLabels, "LIVE TOTALS", "PEAK THRUST", "PEAK PRESSURE", "IMPULSE SO FAR"])
      assert.equal(cardTexts.filter((text) => text.value === value).length, 1, value);
    const notes = cardTexts.findIndex(({ value }) => value === "NOTES");
    const liveHeading = cardTexts.findIndex(({ value }) => value === "LIVE TOTALS");
    const noteLines = cardTexts.slice(notes + 1, liveHeading);
    assert.ok(noteLines.length > 1, "Long notes use additional rows instead of a wide card");
    assert.ok(noteLines.every(({ size }) => size / geometry.scale >= 12),
      "Wrapped notes retain readable text");
    const lastMetadataBottom = Math.max(...cardTexts.slice(0, liveHeading).map(({ bottom }) => bottom));
    const firstLiveTop = Math.min(...cardTexts.slice(liveHeading).map(({ top }) => top));
    assert.ok(lastMetadataBottom + 12 * geometry.scale <= firstLiveTop,
      "The metadata card has a clear gap before live totals");
    assertNoTextOverlap(cardTexts, `${width} × ${height} left cards`);
    for (const text of cardTexts) assertInside(text, left);
    const composition = compositionGeometry(width, height, 1920, 1080,
      { ...defaultStyle, layout: "stacked" });
    const header = texts.filter((text) => inBox(text, composition.header));
    const footer = texts.filter((text) => inBox(text, composition.sources));
    assert.equal(header.length, 3);
    for (const text of header) assertInside(text, composition.header);
    for (const text of footer) assertInside(text, composition.sources);
    assertUncompressed(texts);
  }
});
