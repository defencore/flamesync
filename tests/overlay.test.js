import test from "node:test";
import assert from "node:assert/strict";
import { drawComposition, compositionGeometry } from "../src/composition.js";
import {
  defaultStyle,
  defaultMetadata,
  overlayGeometry,
  overlayHeight,
  chartAxis,
} from "../src/overlay.js";
import { parseCSV, chartPoints } from "../src/data.js";
import { presentationScale } from "../src/composition-layout.js";

function recordingContext(width, height) {
  const transforms = [];
  let transform = { x: 0, y: 0, sx: 1, sy: 1 };
  const context = {
    canvas: { width, height },
    font: "10px system-ui",
    textAlign: "left",
    texts: [],
    measurements: 0,
    save() {
      transforms.push({ ...transform, font: this.font, align: this.textAlign });
    },
    restore() {
      const saved = transforms.pop();
      transform = saved;
      this.font = saved.font;
      this.textAlign = saved.align;
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
      });
    },
    beginPath() {},
    rect() {},
    clip() {},
    fillRect() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    setLineDash() {},
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
    { ...defaultStyle, ...style },
    { ...defaultMetadata, ...metadata },
    sourceInfo,
    measurement,
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
    assert.ok(chart.x + chart.width + 52 < metrics.divider);
    assert.ok(metrics.x + metrics.width < geometry.width);
    assert.ok(metrics.rowHeight >= 30);
    assert.ok(chart.y + chart.height + 22 < geometry.footer.y);
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
          assert.deepEqual(overlayGeometry(width, height, style), plot);
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
  assert.equal(texts.filter((value) => value.startsWith("Δt ")).length, 1);
  assert.ok(!texts.some((value) => /SO FAR|BURN INTERVAL|VIDEO & LOG|CSV TIME/.test(value)));
  assertUncompressed(rendered.filter((item) => !item.value.startsWith("Δt ")));
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
