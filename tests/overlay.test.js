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
      const width = Math.min(String(value).length * size * 0.54, maximum);
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
    assert.ok(overlayHeight(width, height, style) <= height * 0.55 + 1e-9);
    const composition = compositionGeometry(width, height, 1920, 1080, style);
    assert.ok(
      composition.video.y + composition.video.height <=
        height - composition.panelHeight + 1e-9,
    );
  }
});

test("populated records keep model, ISO date, source frame, and physical CSV row in a compact hierarchy", () => {
  const ctx = recordingContext(1280, 720);
  const sourceInfo = {
    width: 1920,
    height: 1080,
    fps: 120,
    timestamps: new Float64Array([0, 0.008, 0.025, 0.1, 0.15]),
    end: 0.2,
  };
  const texts = render(ctx, {
    sourceInfo,
    measurement: { start: 0.05, end: 0.15 },
  }).map(({ value }) => value);
  assert.ok(texts.indexOf(populated.motor) < texts.indexOf("LIVE TOTALS"));
  assert.ok(texts.indexOf("LIVE TOTALS") < texts.indexOf("VIDEO & LOG"));
  assert.ok(texts.indexOf("VIDEO & LOG") < texts.indexOf("TEST RECORD"));
  for (const value of [
    "2026-10-17",
    "Frame 000004 / 5",
    "0.100000 s",
    "CSV row 3",
    "FIRE-024",
    "Range North",
    "50 Hz",
  ])
    assert.ok(texts.includes(value), value);
  assert.equal(texts.filter((value) => value.startsWith("Δt ")).length, 1);
  assert.ok(!texts.some((value) => /SO FAR|BURN INTERVAL/.test(value)));
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
  assert.ok(final.some(({ value }) => value === "CSV time".toUpperCase()));
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
    const overlayStart = texts.findIndex(({ value }) => value === "TELEMETRY");
    const side = texts.slice(0, overlayStart);
    assert.ok(side.some(({ value }) => value.startsWith("Frame ")));
    assert.ok(side.some(({ value }) => value.startsWith("CSV row ")));
    assert.ok(side.some(({ value }) => value === "2026-10-17"));
    for (const text of side) {
      assert.ok(text.left > baseline.info.x, text.value);
      assert.ok(text.right < width, text.value);
      assert.ok(
        text.top >= 0 && text.bottom < height - baseline.panelHeight,
        text.value,
      );
    }
    assert.deepEqual(
      compositionGeometry(width, height, 1920, 1080, style),
      baseline,
    );
  }
});

test("metadata wrapping is cached while source-frame and live-value updates remain current", () => {
  const ctx = recordingContext(1280, 720);
  const metadata = {
    ...populated,
    notes: "Detailed recording conditions ".repeat(30),
  };
  render(ctx, { metadata, time: 0.1 });
  const initialMeasurements = ctx.measurements;
  ctx.measurements = 0;
  ctx.texts.length = 0;
  render(ctx, { metadata, time: 0.2 });
  assert.ok(ctx.measurements < initialMeasurements / 2);
  const peak = ctx.texts.findIndex(({ value }) => value === "PEAK THRUST");
  assert.equal(ctx.texts[peak + 1].value, "100.0 N");
});

test("primary values and compact clock/impulse rows remain separate at minimum height", () => {
  for (const [width, height] of [
    [1280, 720],
    [1080, 1920],
    [4096, 540],
  ]) {
    const ctx = recordingContext(width, height);
    const texts = render(ctx, {
      style: { height: 5, showPressure: true, showImpulse: true },
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
    for (const label of ["CSV TIME", "IMPULSE"]) {
      const index = texts.findIndex(({ value }) => value === label);
      const heading = texts[index];
      const value = texts[index + 1];
      assert.ok(heading.right < value.left, `${label}: value covers label`);
      assert.ok(heading.top > previous.bottom, `${label}: preceding row overlaps`);
      assert.ok(value.bottom < height, `${label}: value leaves the frame`);
      previous = value;
    }
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
    const end = long.findIndex(({ value }) => value === "TELEMETRY");
    for (const item of long.slice(0, end)) {
      assert.ok(item.left > geometry.info.x && item.right < width, item.value);
      assert.ok(item.top >= 0 && item.bottom < geometry.info.height, item.value);
    }
  }
});
