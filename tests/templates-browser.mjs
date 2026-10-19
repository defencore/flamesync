import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Input, BufferSource, EncodedPacketSink, ALL_FORMATS } from "mediabunny";
import { compositionGeometry } from "../src/composition-layout.js";
import { defaultStyle, overlayGeometry } from "../src/overlay.js";

function profile(name, { offset = 0, unit = "ms", rate = 50, thrust = 10, pressure = 2 } = {}) {
  const multiplier = { ms: 1000, us: 1000000 }[unit];
  const rows = [`time_${unit};thrust;pressure`];
  for (let index = 0; index <= rate * 30; index++) {
    const time = index / rate;
    const burning = time >= 1 && time <= 3;
    rows.push(`${Math.round((offset + time) * multiplier)};${burning ? thrust : 0};${burning ? pressure : 0}`);
  }
  return { name, mimeType: "text/csv", buffer: Buffer.from(rows.join("\n")) };
}

/** Verify public template controls, real canvas output, and encoded video. */
export async function verifyTemplates({ browser, baseURL, outputDir }) {
  const failures = [], requests = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: "en-US" });
  page.on("pageerror", (error) => failures.push(`Video templates: ${error.message}`));
  page.on("console", (entry) => { if (entry.type() === "error") failures.push(`Video templates: ${entry.text()}`); });
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  // Canvas instrumentation observes visible labels and video bounds without
  // reading private application state or installing application test hooks.
  await page.addInitScript(() => {
    window.__templateDrawing = { texts: [], videos: [], strokes: [] };
    const fillRect = CanvasRenderingContext2D.prototype.fillRect;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    const strokeText = CanvasRenderingContext2D.prototype.strokeText;
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
      if (this.canvas.id === "preview" && x === 0 && y === 0 && width === this.canvas.width && height === this.canvas.height)
        window.__templateDrawing = { texts: [], videos: [], strokes: [] };
      return fillRect.call(this, x, y, width, height);
    };
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...arguments_) {
      if (this.canvas.id === "preview") {
        const transform = this.getTransform();
        const point = new DOMPoint(x, y).matrixTransform(transform);
        window.__templateDrawing.texts.push({ text: String(text), x: point.x, y: point.y,
          font: this.font, color: this.fillStyle, shadowColor: this.shadowColor, shadowBlur: this.shadowBlur,
          width: this.measureText(String(text)).width * Math.hypot(transform.a, transform.b), align: this.textAlign });
      }
      return fillText.call(this, text, x, y, ...arguments_);
    };
    CanvasRenderingContext2D.prototype.strokeText = function (text, x, y, ...arguments_) {
      if (this.canvas.id === "preview") {
        const point = new DOMPoint(x, y).matrixTransform(this.getTransform());
        window.__templateDrawing.strokes.push({ text: String(text), x: point.x, y: point.y,
          color: this.strokeStyle, width: this.lineWidth });
      }
      return strokeText.call(this, text, x, y, ...arguments_);
    };
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...arguments_) {
      if (this.canvas.id === "preview" && source instanceof HTMLVideoElement && arguments_.length === 4)
        window.__templateDrawing.videos.push(arguments_);
      return drawImage.call(this, source, ...arguments_);
    };
  });
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const reveal = async (input) => {
    const ancestors = input.locator("xpath=ancestor::details");
    for (let index = 0; index < await ancestors.count(); index++) {
      const details = ancestors.nth(index);
      if (!await details.evaluate((element) => element.open)) await details.locator(":scope > summary").click();
    }
  };
  const change = async (id, value) => {
    const input = page.locator(`#${id}`); await reveal(input); await input.fill(String(value)); await input.press("Tab"); await frame();
  };
  const select = async (id, value) => {
    const input = page.locator(`#${id}`); await reveal(input); await input.selectOption(value); await frame();
  };
  const range = async (id, value) => {
    const input = page.locator(`#${id}`); await reveal(input);
    await input.evaluate((element, next) => {
      element.value = String(next); element.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    await frame();
  };
  const seek = async (time) => {
    await page.locator("#scrubber").evaluate((input, value) => {
      input.value = String(value); input.dispatchEvent(new Event("input", { bubbles: true }));
    }, time);
    await page.waitForFunction((time) => {
      const video = document.querySelector("#source-video");
      return !video.seeking && Math.abs(video.currentTime - time) < 0.002;
    }, time);
    await frame();
  };
  const drawing = () => page.evaluate(() => window.__templateDrawing);
  const image = () => page.locator("#preview").evaluate((canvas) => canvas.toDataURL());
  const pixelDigest = () => page.locator("#preview").evaluate(async (canvas) => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const digest = await crypto.subtle.digest("SHA-256", pixels);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
  const activeSpan = (box) => page.locator("#preview").evaluate((canvas, box) => {
    const context = canvas.getContext("2d");
    const left = Math.ceil(box.x), top = Math.ceil(box.y);
    const width = Math.floor(box.width), height = Math.floor(box.height * 0.7);
    const pixels = context.getImageData(left, top, width, height).data;
    let minimum = width, maximum = -1, count = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
      if (red > 140 && red > green * 1.32 && green > blue * 1.2) {
        minimum = Math.min(minimum, x); maximum = Math.max(maximum, x); count++;
      }
    }
    return { fraction: maximum >= minimum ? (maximum - minimum) / width : 0, count };
  }, box);
  const caseOf = async (name, run) => {
    try { await run(); console.log(`PASS: ${name}`); }
    catch (error) {
      failures.push(`${name}: ${error.stack || error.message || String(error)}`);
      await page.screenshot({ path: join(outputDir, `templates-failure-${failures.length}.png`), fullPage: true }).catch(() => {});
    }
  };
  const stackedStyle = { ...defaultStyle, layout: "stacked", chartRange: "burn" };
  const geometry = compositionGeometry(1920, 1080, 960, 540, stackedStyle);
  const overlay = overlayGeometry(1920, 1080, stackedStyle);
  const scaledBox = (box) => Object.fromEntries(Object.entries(box).map(([key, value]) => [key, value * overlay.scale]));
  const thrustBox = scaledBox(overlay.plots.thrust);
  const assertGuideGeometry = async (context) => {
    await page.locator("#preview").scrollIntoViewIfNeeded(); await frame();
    const observed = await page.locator("#video-framing-guides").evaluate((svg) => {
      const canvas = document.querySelector("#preview");
      const bounds = canvas.getBoundingClientRect();
      const scale = Math.min(bounds.width / canvas.width, bounds.height / canvas.height);
      const content = { x: bounds.x + (bounds.width - canvas.width * scale) / 2,
        y: bounds.y + (bounds.height - canvas.height * scale) / 2, scale };
      const matrix = svg.getScreenCTM();
      const lines = [...svg.querySelectorAll("line[data-guide]")].map((line) => {
        const style = getComputedStyle(line);
        return { role: line.dataset.guide, x1: line.x1.baseVal.value, y1: line.y1.baseVal.value,
          x2: line.x2.baseVal.value, y2: line.y2.baseVal.value,
          appearance: JSON.stringify([style.stroke, style.strokeWidth, style.strokeOpacity, style.opacity, style.strokeDasharray]) };
      });
      return { width: canvas.width, height: canvas.height, content, lines,
        viewBox: [svg.viewBox.baseVal.x, svg.viewBox.baseVal.y, svg.viewBox.baseVal.width, svg.viewBox.baseVal.height],
        matrix: { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f },
        pointerEvents: getComputedStyle(svg).pointerEvents };
    });
    const body = compositionGeometry(observed.width, observed.height, 960, 540, stackedStyle).videoFrame;
    assert.deepEqual(observed.viewBox, [0, 0, observed.width, observed.height], `${context}: guides must share the output canvas coordinate system`);
    assert.equal(observed.pointerEvents, "none", `${context}: guides must never intercept placement gestures`);
    // SVG length baseVal uses float precision: 340.8 becomes 340.7999878.
    // A thousandth of an output pixel still catches misplaced guide geometry.
    const near = (actual, expected, description, tolerance = 0.001) =>
      assert.ok(Math.abs(actual - expected) <= tolerance, `${context}: ${description}, ${actual} versus ${expected}`);
    const vertical = observed.lines.filter((line) => line.x1 === line.x2);
    const horizontal = observed.lines.filter((line) => line.y1 === line.y2);
    assert.equal(vertical.length, 9, `${context}: ten-percent vertical subdivisions`);
    assert.equal(horizontal.length, 9, `${context}: ten-percent horizontal subdivisions`);
    for (let index = 1; index <= 9; index++) {
      const x = body.x + body.width * index / 10, y = body.y + body.height * index / 10;
      const upright = vertical.find((line) => Math.abs(line.x1 - x) < 0.001);
      const across = horizontal.find((line) => Math.abs(line.y1 - y) < 0.001);
      assert.ok(upright && across, `${context}: both axes need the ${index * 10}% division`);
      near(Math.min(upright.y1, upright.y2), body.y, "vertical guide begins below the technical header");
      near(Math.max(upright.y1, upright.y2), body.y + body.height, "vertical guide stops above filenames");
      near(Math.min(across.x1, across.x2), body.x, "horizontal guide starts at the footage boundary");
      near(Math.max(across.x1, across.x2), body.x + body.width, "horizontal guide ends at the footage boundary");
      assert.equal(upright.role, index === 5 ? "center-x" : "grid");
      assert.equal(across.role, index === 5 ? "center-y" : index === 8 ? "base" : "grid");
    }
    const minor = observed.lines.find((line) => line.role === "grid");
    for (const role of ["center-x", "center-y", "base"])
      assert.notEqual(observed.lines.find((line) => line.role === role).appearance, minor.appearance,
        `${context}: ${role} needs a visible emphasis beyond the subdivision grid`);
    const { matrix, content } = observed;
    for (const [x, y] of [[body.x, body.y], [body.x + body.width, body.y + body.height],
      [body.x + body.width / 2, body.y + body.height / 2], [body.x + body.width / 2, body.y + body.height * 0.8]]) {
      near(matrix.a * x + matrix.c * y + matrix.e, content.x + x * content.scale, "guide horizontal screen position follows contained footage", 1);
      near(matrix.b * x + matrix.d * y + matrix.f, content.y + y * content.scale, "guide vertical screen position follows contained footage", 1);
    }
    return { body, ...observed };
  };
  const mediaModule = await readFile(new URL("../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs", import.meta.url), "utf8");
  await page.route("**/__qa__/template-media.mjs", (route) => route.fulfill({ contentType: "text/javascript", body: mediaModule }));

  try {
    await page.goto(baseURL);
    await select("language-select", "en");
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await caseOf("templates preserve the existing presentation and default to a focused burn window", async () => {
      assert.equal(await page.locator("#presentation-layout").inputValue(), "full");
      assert.equal(await page.locator("#chart-range").inputValue(), "burn");
      for (const value of ["full", "stacked", "overlay"])
        assert.equal(await page.locator(`#presentation-layout option[value="${value}"]`).count(), 1);
      assert.equal(await page.locator("#export-resolution").inputValue(), "1920");
      assert.equal(await page.locator("#export-format").inputValue(), "mp4");
      assert.equal(await page.locator("#export-quality").inputValue(), "very-high");
      assert.deepEqual(await page.locator("#preview").evaluate((canvas) => [canvas.width, canvas.height]), [1920, 1080]);
    });

    // This intentionally bright source reveals panels that rely on dark footage
    // for contrast. Corner marks also make accidental cropping detectable.
    const brightVideo = Buffer.from(await page.evaluate(async () => {
      const { Output, BufferTarget, Mp4OutputFormat, CanvasSource } = await import(`${location.origin}/__qa__/template-media.mjs`);
      const canvas = new OffscreenCanvas(960, 540);
      const context = canvas.getContext("2d");
      const paint = () => {
        context.fillStyle = "#ffffff"; context.fillRect(0, 0, 960, 540);
        for (const [color, x, y] of [["#ff0000", 0, 0], ["#0000ff", 0, 500], ["#00ff00", 920, 0], ["#ff00ff", 920, 500]]) {
          context.fillStyle = color; context.fillRect(x, y, 40, 40);
        }
      };
      const target = new BufferTarget();
      const output = new Output({ target, format: new Mp4OutputFormat() });
      const source = new CanvasSource(canvas, { codec: "avc", bitrate: 1000000 });
      output.addVideoTrack(source); await output.start();
      let timestamp = 0;
      for (let index = 0; index < 96; index++) {
        paint(); const duration = [1 / 30, 1 / 60, 1 / 24, 1 / 24][index % 4];
        await source.add(timestamp, duration); timestamp += duration;
      }
      source.close(); await output.finalize();
      return Array.from(new Uint8Array(target.buffer));
    }));
    const sourceInput = new Input({ source: new BufferSource(brightVideo), formats: ALL_FORMATS });
    const sourceTimestamps = [];
    try {
      const track = await sourceInput.getPrimaryVideoTrack(); assert.ok(track);
      for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true }))
        sourceTimestamps.push(packet.timestamp);
      sourceTimestamps.sort((a, b) => a - b);
    } finally { sourceInput.dispose(); }
    await page.locator("#video-input").setInputFiles({ name: "bright-field-source.mp4", mimeType: "video/mp4", buffer: brightVideo });
    await page.waitForFunction(() => document.querySelector("#timing-video-detail").textContent.includes("frames checked"), undefined, { timeout: 60000 });
    await page.locator("#csv-input").setInputFiles(profile("measured-long-tail.csv"));
    await page.waitForFunction(() => document.querySelector("#csv-filename").textContent.includes("measured-long-tail.csv"));
    await page.locator("#tool-measurement").click();
    await change("measure-start", 1); await change("measure-end", 3);
    await page.getByRole("tab", { name: "Project", exact: true }).click();
    await change("meta-motor", "QA MOTOR 10"); await change("meta-testDate", "2026-10-20");
    await change("meta-testId", "SERIES-007"); await change("meta-logger", "LOCAL LOGGER"); await change("meta-camera", "BRIGHT FIELD CAMERA");
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await select("presentation-layout", "stacked"); await seek(2);

    await caseOf("stacked charts are separate tall plots over uncropped footage", async () => {
      assert.ok(overlay.plots.pressure, "The stacked template needs an independent pressure graph");
      assert.ok(overlay.plots.thrust.height > 180 && overlay.plots.pressure.height > 180, "Both graphs must have useful vertical resolution");
      assert.ok(overlay.plots.pressure.y > overlay.plots.thrust.y + overlay.plots.thrust.height);
      assert.equal(overlay.plots.thrust.x, overlay.plots.pressure.x);
      assert.equal(overlay.plots.thrust.width, overlay.plots.pressure.width);
      assert.ok(geometry.video.width > 1700 && geometry.video.height > 950, "Footage should occupy the full canvas above filenames");
      assert.ok(Math.abs(geometry.video.width / geometry.video.height - 16 / 9) < 1e-6, "Source aspect ratio must remain intact");
      const observed = (await drawing()).videos.at(-1);
      assert.ok(observed); assert.deepEqual(observed, [geometry.video.x, geometry.video.y, geometry.video.width, geometry.video.height]);
      const before = observed;
      await page.locator("#show-pressure").uncheck(); await frame();
      assert.deepEqual((await drawing()).videos.at(-1), before, "Hiding pressure must not resize or crop footage");
      await page.locator("#show-pressure").check(); await frame();
      assert.deepEqual((await drawing()).videos.at(-1), before);
    });

    await caseOf("burn focus fills the graph while full range preserves long CSV tails and physical metrics", async () => {
      await seek(3.05);
      const before = await page.locator("#measure-duration").textContent();
      const focused = await activeSpan(thrustBox);
      assert.ok(focused.count > 100 && focused.fraction > 0.65, `Burn must fill the graph rather than being compressed: ${JSON.stringify(focused)}`);
      await select("chart-range", "full");
      const full = await activeSpan(thrustBox);
      assert.ok(full.count > 10 && full.fraction < 0.15, `Full CSV range should retain the 30-second clock: ${JSON.stringify(full)}`);
      assert.equal(await page.locator("#measure-duration").textContent(), before, "A display range must never alter burn duration");
      assert.equal(Number(await page.locator("#measure-start").inputValue()), 1);
      assert.equal(Number(await page.locator("#measure-end").inputValue()), 3);
      await select("chart-range", "burn");
      assert.ok((await activeSpan(thrustBox)).fraction > 0.65);
    });

    await caseOf("theory with a different clock and long tails does not compress the measured burn", async () => {
      await page.locator("#theory-input").setInputFiles(profile("theory-independent-us.csv", { offset: 50, unit: "us", rate: 80, thrust: 8, pressure: 1 }));
      await page.waitForFunction(() => document.querySelector("#theory-panel").getAttribute("aria-busy") !== "true");
      await change("theory-start", 51); await change("theory-end", 53);
      await select("theory-alignment", "ignition"); await seek(3.05);
      const on = await image();
      assert.ok((await activeSpan(thrustBox)).fraction > 0.65, "A long theoretical CSV tail must not change a focused burn domain");
      await page.locator("#theory-enabled").uncheck(); await frame();
      assert.notEqual(await image(), on, "The theoretical reference must be visible in the new template");
      await page.locator("#theory-enabled").check(); await frame();
    });

    await caseOf("source frame and log clocks share a top header while metadata stays over footage and names stay below", async () => {
      const { texts } = await drawing();
      const footerTop = geometry.sources.y;
      const headerBottom = geometry.header.y + geometry.header.height;
      for (const content of ["QA MOTOR 10", "2026-10-20", "SERIES-007", "LOCAL LOGGER", "BRIGHT FIELD CAMERA"])
        assert.ok(texts.some(({ text, y }) => text.includes(content) && y > headerBottom && y < footerTop), `${content} should sit over footage`);
      for (const expression of [/^Frame /, /^Log row /]) {
        const labels = texts.filter(({ text }) => expression.test(text));
        assert.equal(labels.length, 1, `${expression} must be displayed once without duplicate footage labels`);
        assert.ok(labels[0].y > geometry.header.y && labels[0].y < headerBottom, `${expression} should be in the top header`);
      }
      for (const expression of [/Burn duration.*2\.000/, /^A$/, /^B$/])
        assert.ok(texts.some(({ text, y }) => expression.test(text) && y > headerBottom && y < footerTop), `${expression} should be present over footage`);
      for (const filename of ["bright-field-source.mp4", "measured-long-tail.csv"])
        assert.ok(texts.some(({ text, y }) => text.includes(filename) && y >= footerTop), `${filename} should remain in the source footer`);
      const top = texts.filter(({ y }) => y < headerBottom);
      assert.equal(top.length, 3, "The landscape header should contain three compact fields without separate category headings");
      assert.ok(geometry.header.height <= 48, "The landscape technical strip should leave room for footage");
      assert.ok(Math.max(...top.map(({ y }) => y)) - Math.min(...top.map(({ y }) => y)) <= 1,
        "Landscape frame, log, and acquisition fields must share one horizontal baseline");
      const bounds = top.map(({ x, width, align }) => ({ left: x - (align === "right" ? width : align === "center" ? width / 2 : 0), width }))
        .sort((a, b) => a.left - b.left);
      assert.ok(bounds[0].left >= 0 && bounds.at(-1).left + bounds.at(-1).width <= geometry.header.width,
        "Technical fields must stay inside the video header");
      for (let index = 1; index < bounds.length; index++) assert.ok(bounds[index].left >= bounds[index - 1].left + bounds[index - 1].width + 12,
        "Compact header fields must keep readable spacing without overlaps");
      assert.ok(top.some(({ text }) => /960 × 540.*fps.*VFR.*50\.0 Hz avg/.test(text)), "One acquisition field should identify dimensions, source cadence, variable timing, and logger cadence");
      assert.ok(!top.some(({ text }) => /CSV|VIDEO FRAME|CSV POSITION|ACQUISITION|PTS|Δ|kgf \/ bar/.test(text)),
        "The compact header should avoid redundant categories and detailed diagnostics retained in the inspector");
      assert.ok(!texts.some(({ text, y }) => y > headerBottom && y < footerTop && /CSV time|· CSV/.test(text)),
        "Burn duration and graph time labels must not repeat the CSV source label over footage");
      assert.ok(!texts.some(({ text }) => /NaN|undefined|Infinity/.test(text)), "The video must contain valid readable values");
    });

    await caseOf("compact frame and log fields preserve native VFR clocks while the inspector retains exact frame intervals", async () => {
      await seek(2);
      const intervals = [];
      for (let step = 0; step < 4; step++) {
        if (step) {
          const previous = Number(await page.locator("#video-frame-number").textContent());
          await page.locator("#frame-next").click();
          await page.waitForFunction((value) => !document.querySelector("#source-video").seeking && Number(document.querySelector("#video-frame-number").textContent) !== value, previous);
          await frame();
        }
        const counter = Number(await page.locator("#video-frame-number").textContent());
        const expectedPTS = sourceTimestamps[counter - 1];
        const nextPTS = sourceTimestamps[counter] ?? 3.2;
        const { texts } = await drawing();
        const top = texts.filter(({ y }) => y < geometry.header.y + geometry.header.height);
        assert.ok(top.some(({ text }) => text === `Frame ${String(counter).padStart(6, "0")} / 96 · ${expectedPTS.toFixed(6)} s`),
          `Top header must use the source packet clock for frame ${counter}: ${JSON.stringify(top)}`);
        const row = await page.locator("#video-log-row").textContent();
        assert.ok(top.some(({ text }) => text === `Log row ${row} · ${expectedPTS.toFixed(6)} s`),
          `One log field must combine matching physical rows with the native-seconds CSV clock: ${row}`);
        assert.equal(Number.parseFloat(await page.locator("#video-frame-interval").textContent()), Number(((nextPTS - expectedPTS) * 1000).toFixed(3)),
          "Detailed unequal frame intervals must remain available in the source inspector");
        intervals.push((nextPTS - expectedPTS).toFixed(6));
      }
      assert.ok(new Set(intervals).size > 1, "The fixture must exercise unequal source frame intervals");
      await seek(2);
      await page.locator("#tool-timeline").click(); await change("sync-offset", 0.123456); await seek(2);
      const shiftedTop = (await drawing()).texts.filter(({ y }) => y < geometry.header.y + geometry.header.height);
      const row = await page.locator("#video-log-row").textContent();
      assert.ok(shiftedTop.some(({ text }) => /^Frame .* · 2\.000000 s$/.test(text)), "Offsetting telemetry must not change the source frame clock");
      assert.ok(shiftedTop.some(({ text }) => text === `Log row ${row} · 1.876544 s`), "The compact log field must retain its own shifted clock rather than reusing the video timestamp");
      await change("sync-offset", 0); await seek(2);
    });

    await caseOf("framing sliders and keyboard controls position footage without changing synchronization or analysis", async () => {
      await page.getByRole("tab", { name: "Appearance", exact: true }).click();
      assert.equal(await page.locator("#video-framing").isVisible(), true);
      for (const [id, initial, minimum, maximum] of [["video-scale", "100", "50", "200"], ["video-position-x", "0", "-50", "50"], ["video-position-y", "0", "-50", "50"]]) {
        const control = page.locator(`#${id}`); await reveal(control);
        assert.equal(await control.inputValue(), initial);
        assert.equal(await control.getAttribute("min"), minimum);
        assert.equal(await control.getAttribute("max"), maximum);
      }
      const temporalControls = ["trim-start", "trim-end", "sync-offset", "measure-start", "measure-end", "theory-start", "theory-end", "theory-offset", "theory-scale"];
      const before = await Promise.all(temporalControls.map((id) => page.locator(`#${id}`).inputValue()));
      const counter = await page.locator("#video-frame-number").textContent();
      await range("video-scale", 175); await range("video-position-x", 20); await range("video-position-y", -12);
      const expected = compositionGeometry(1920, 1080, 960, 540, { ...stackedStyle, videoScale: 175, videoX: 20, videoY: -12 }).video;
      assert.deepEqual((await drawing()).videos.at(-1), [expected.x, expected.y, expected.width, expected.height]);
      assert.match(await page.locator("#video-scale-value").textContent(), /175/);
      assert.match(await page.locator("#video-position-x-value").textContent(), /20/);
      assert.match(await page.locator("#video-position-y-value").textContent(), /12/);
      const horizontal = page.locator("#video-position-x"); await horizontal.focus(); await horizontal.press("ArrowRight"); await frame();
      assert.ok(Number(await horizontal.inputValue()) > 20, "A focused position slider must respond to keyboard arrows");
      assert.equal(await page.locator("#video-frame-number").textContent(), counter, "Position sliders must not trigger frame stepping");
      assert.deepEqual(await Promise.all(temporalControls.map((id) => page.locator(`#${id}`).inputValue())), before,
        "Framing must leave trim, synchronization, measured boundaries, and theoretical source settings intact");
      await page.locator("#video-framing-reset").click(); await frame();
      assert.deepEqual(await Promise.all(["video-scale", "video-position-x", "video-position-y"].map((id) => page.locator(`#${id}`).inputValue())), ["100", "0", "0"]);
      assert.deepEqual((await drawing()).videos.at(-1), [geometry.video.x, geometry.video.y, geometry.video.width, geometry.video.height]);
    });

    await caseOf("movement guides follow the footage body across resizing, portrait output, and fullscreen without entering the canvas", async () => {
      await seek(2);
      const button = page.locator("#video-framing-drag"), guides = page.locator("#video-framing-guides");
      assert.equal(await guides.isVisible(), false);
      const clean = await pixelDigest();
      const cleanDrawing = await drawing();
      const nativeTime = await page.locator("#source-video").evaluate((video) => video.currentTime);
      const sourceFrame = await page.locator("#video-frame-number").textContent();
      try {
        await button.click(); await frame();
        assert.equal(await guides.isVisible(), true);
        const desktop = await assertGuideGeometry("desktop");
        assert.equal(await pixelDigest(), clean, "Showing editor guides must not change any rendered output pixel");
        await button.click(); assert.equal(await guides.isVisible(), false);
        assert.equal(await pixelDigest(), clean, "Hiding guides at the same output size must preserve every canvas pixel");
        await button.click(); assert.equal(await guides.isVisible(), true);
        assert.equal(await pixelDigest(), clean, "Showing guides again must preserve the same clean output pixels");
        assert.equal(await page.evaluate(({ body, content }) => document.elementFromPoint(
          content.x + (body.x + body.width / 2) * content.scale,
          content.y + (body.y + body.height / 2) * content.scale)?.id, desktop), "preview",
        "Pointer events at crossing guides must reach the video canvas");
        await page.locator("#preview-stage").screenshot({ path: join(outputDir, "templates-framing-grid-desktop.png") });
        await page.setViewportSize({ width: 390, height: 844 }); await frame();
        await assertGuideGeometry("mobile CSS resize");
        assert.equal(await pixelDigest(), clean, "Responsive guide positioning must not alter the output canvas");
        await page.locator("#preview-stage").screenshot({ path: join(outputDir, "templates-framing-grid-mobile.png") });
        await select("frame-aspect", "portrait"); await assertGuideGeometry("portrait output");
        await page.locator("#preview-stage").screenshot({ path: join(outputDir, "templates-framing-grid-portrait.png") });
        await select("frame-aspect", "landscape");
        await page.setViewportSize({ width: 1440, height: 1050 }); await frame();
        await assertGuideGeometry("restored landscape");
        assert.deepEqual(await drawing(), cleanDrawing, "Returning to landscape must preserve composition labels, native frame PTS, and source image bounds");
        assert.equal(await page.locator("#source-video").evaluate((video) => video.currentTime), nativeTime);
        assert.equal(await page.locator("#video-frame-number").textContent(), sourceFrame);
        // Intrinsic resizing resets browser raster caches. The exact pixel
        // checks above isolate guide toggles from that separate context reset.
        if (await page.evaluate(() => document.fullscreenEnabled)) {
          await page.locator("#fullscreen").click();
          await page.waitForFunction(() => document.fullscreenElement?.id === "preview-stage");
          await assertGuideGeometry("fullscreen");
          assert.deepEqual(await drawing(), cleanDrawing, "Fullscreen guides must not alter composed data, timestamps, or source image bounds");
          await page.locator("#preview-stage").screenshot({ path: join(outputDir, "templates-framing-grid-fullscreen.png") });
          await page.evaluate(() => document.exitFullscreen());
          await page.waitForFunction(() => !document.fullscreenElement);
          await assertGuideGeometry("after fullscreen");
        }
        const framingBefore = await Promise.all(["video-position-x", "video-position-y"].map((id) => page.locator(`#${id}`).inputValue()));
        const rectangle = await page.locator("#preview").boundingBox(); assert.ok(rectangle);
        const x = rectangle.x + rectangle.width * 0.4, y = rectangle.y + rectangle.height * 0.5;
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x + rectangle.width * 0.06, y + rectangle.height * 0.04, { steps: 4 }); await frame();
        assert.notDeepEqual(await Promise.all(["video-position-x", "video-position-y"].map((id) => page.locator(`#${id}`).inputValue())), framingBefore,
          "Resize cancellation must exercise an actual changed placement draft");
        await page.setViewportSize({ width: 1280, height: 850 });
        await page.waitForFunction(() => !document.querySelector("#preview").classList.contains("dragging"));
        await page.mouse.up(); await frame();
        assert.deepEqual(await Promise.all(["video-position-x", "video-position-y"].map((id) => page.locator(`#${id}`).inputValue())), framingBefore,
          "Resizing the display during a drag must cancel the obsolete screen-space draft");
        await assertGuideGeometry("resize during placement");
        await page.setViewportSize({ width: 1440, height: 1050 }); await frame();
        await page.locator("#preview").focus(); await page.keyboard.press("Escape"); await frame();
        assert.equal(await guides.isVisible(), false, "Escape must hide the editor grid along with movement mode");
        assert.deepEqual(await drawing(), cleanDrawing, "Escape must preserve the composition after guide movement is canceled");
        await button.click(); assert.equal(await guides.isVisible(), true);
        await button.click(); assert.equal(await guides.isVisible(), false);
        assert.deepEqual(await drawing(), cleanDrawing, "Toggling movement off must preserve the same composed data and footage bounds");
      } finally {
        await page.mouse.up();
        await page.evaluate(() => document.fullscreenElement ? document.exitFullscreen() : undefined);
        if (await page.locator("#frame-aspect").inputValue() !== "landscape") await select("frame-aspect", "landscape");
        await page.setViewportSize({ width: 1440, height: 1050 });
        if (await button.getAttribute("aria-pressed") === "true") await button.click();
        await frame();
      }
    });

    await caseOf("preview drag supports committing, pointer cancellation, Escape, and reset without covering the source header", async () => {
      const preview = page.locator("#preview"), button = page.locator("#video-framing-drag");
      await button.click(); assert.equal(await button.getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("#video-framing-guides").isVisible(), true, "Placement gestures should display the alignment grid");
      const rectangle = await preview.boundingBox(); assert.ok(rectangle);
      const start = { x: rectangle.x + rectangle.width * 0.42, y: rectangle.y + rectangle.height * 0.55 };
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(start.x + rectangle.width * 0.08, start.y - rectangle.height * 0.05, { steps: 4 });
      await page.mouse.up(); await frame();
      const committed = await Promise.all(["video-position-x", "video-position-y"].map((id) => page.locator(`#${id}`).inputValue()));
      assert.ok(Number(committed[0]) > 4 && Number(committed[1]) < -2, `Dragging should move the source in both directions: ${committed}`);
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(start.x - rectangle.width * 0.06, start.y + rectangle.height * 0.04, { steps: 3 });
      await preview.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse", bubbles: true });
      await page.mouse.up(); await frame();
      assert.deepEqual(await Promise.all(["video-position-x", "video-position-y"].map((id) => page.locator(`#${id}`).inputValue())), committed,
        "Pointer cancellation must restore the gesture's original framing");
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(start.x + rectangle.width * 0.06, start.y + rectangle.height * 0.04, { steps: 3 });
      await page.keyboard.press("Escape"); await page.mouse.up(); await frame();
      assert.deepEqual(await Promise.all(["video-position-x", "video-position-y"].map((id) => page.locator(`#${id}`).inputValue())), committed,
        "Escape must restore the gesture's initial framing");
      assert.equal(await button.getAttribute("aria-pressed"), "false");
      assert.equal(await page.locator("#video-framing-guides").isVisible(), false);
      await button.click(); await preview.focus();
      const counter = await page.locator("#video-frame-number").textContent();
      await preview.press("ArrowRight"); await preview.press("Shift+ArrowUp"); await frame();
      assert.equal(Number(await page.locator("#video-position-x").inputValue()), Number(committed[0]) + 1);
      assert.equal(Number(await page.locator("#video-position-y").inputValue()), Number(committed[1]) - 5);
      assert.equal(await page.locator("#video-frame-number").textContent(), counter, "Canvas placement keys must not move the video playhead");
      await preview.press("Escape");
      await range("video-position-y", -50); await range("video-scale", 200);
      const { texts } = await drawing();
      const headerLabels = texts.filter(({ y }) => y < geometry.header.y + geometry.header.height);
      assert.ok(headerLabels.some(({ text }) => /^Frame /.test(text)) && headerLabels.some(({ text }) => /^Log row /.test(text)),
        "Panning beyond the top of the canvas must not overwrite the technical header");
      const headerPixels = await preview.evaluate((canvas) => Array.from(canvas.getContext("2d").getImageData(1, 1, 1, 1).data));
      assert.ok(Math.max(...headerPixels.slice(0, 3)) < 80, `The bright source should remain clipped below the opaque header: ${headerPixels}`);
      await page.locator("#video-framing-reset").click(); await frame();
    });

    await caseOf("a quick drag during a queued seek commits after decoding and Escape can cancel that pending commit", async () => {
      const preview = page.locator("#preview"), button = page.locator("#video-framing-drag");
      for (const cancel of [false, true]) {
        await button.click();
        const rectangle = await preview.boundingBox(); assert.ok(rectangle);
        // A real held pointer lets the browser own pointer capture; all gesture
        // events then run together while a real source seek remains in flight.
        await page.mouse.move(rectangle.x + rectangle.width * 0.4, rectangle.y + 2);
        await page.mouse.down();
        const seeking = await preview.evaluate((canvas, { rectangle, cancel }) => {
          const scrubber = document.querySelector("#scrubber");
          for (const time of [1.234, 2.123]) {
            scrubber.value = String(time); scrubber.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const x = rectangle.x + rectangle.width * 0.4, y = rectangle.y + rectangle.height * 0.5;
          for (const [type, dx, dy] of [["pointerdown", 0, 0], ["pointermove", 0.08, -0.04], ["pointerup", 0.08, -0.04]])
            canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0,
              buttons: type === "pointerup" ? 0 : 1, bubbles: true, clientX: x + dx * rectangle.width, clientY: y + dy * rectangle.height }));
          if (cancel) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          return document.querySelector("#source-video").seeking;
        }, { rectangle, cancel });
        await page.mouse.up();
        assert.equal(seeking, true, "The quick drag must exercise an actual pending source seek");
        await page.waitForFunction(() => !document.querySelector("#source-video").seeking);
        await frame();
        const values = await Promise.all(["video-position-x", "video-position-y"].map((id) => page.locator(`#${id}`).inputValue()));
        if (cancel) assert.deepEqual(values, ["0", "0"], "Escape must discard a released gesture before its decode finishes");
        else {
          assert.ok(Number(values[0]) > 4 && Number(values[1]) < -2, `A completed quick drag must not be lost while decoding: ${values}`);
          await button.click(); await page.locator("#video-framing-reset").click(); await frame();
        }
      }
    });

    await caseOf("help dialogs and pinned information keep their Escape behavior while video movement is enabled", async () => {
      const button = page.locator("#video-framing-drag");
      await button.click();
      await page.locator("#help-open").click();
      assert.equal(await page.locator("#help-dialog").evaluate((dialog) => dialog.open), true);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("#help-dialog").open);
      assert.equal(await button.getAttribute("aria-pressed"), "true", "Closing help must leave the underlying movement mode alone");
      await page.getByRole("button", { name: "About video framing", exact: true }).click();
      assert.equal(await page.locator("#info-tooltip").isVisible(), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#info-tooltip").isVisible(), false, "Escape must dismiss the topmost pinned information");
      assert.equal(await button.getAttribute("aria-pressed"), "true", "Dismissing a tooltip must not also cancel movement mode");
      await page.locator("#preview").focus(); await page.keyboard.press("Escape");
      assert.equal(await button.getAttribute("aria-pressed"), "false");
    });

    await caseOf("dark translucent charts retain contrast over a bright recording", async () => {
      await page.getByRole("tab", { name: "Appearance", exact: true }).click();
      assert.equal(await page.locator("#opacity-setting").isVisible(), true);
      assert.equal(await page.locator("#overlay-opacity").getAttribute("min"), "0");
      assert.equal(await page.locator("#overlay-opacity").getAttribute("max"), "95");
      await range("overlay-opacity", 80);
      const contrast = await page.locator("#preview").evaluate((canvas, box) => {
        const context = canvas.getContext("2d");
        const data = context.getImageData(Math.round(box.x + 5), Math.round(box.y + 20), 10, 10).data;
        const brightness = (data[0] + data[1] + data[2]) / 3;
        const outside = context.getImageData(500, 300, 1, 1).data;
        return { brightness, outside: (outside[0] + outside[1] + outside[2]) / 3 };
      }, thrustBox);
      assert.ok(contrast.outside > 240, `The synthetic recording should remain bright: ${JSON.stringify(contrast)}`);
      assert.ok(contrast.brightness > 20 && contrast.brightness < 115, `The panel should darken bright footage without becoming fully opaque: ${JSON.stringify(contrast)}`);
      await range("overlay-opacity", 0);
      const transparent = await page.locator("#preview").evaluate((canvas, { box, body }) => {
        const data = canvas.getContext("2d").getImageData(Math.round(box.x + 5), Math.round(box.y + 20), 1, 1).data;
        const motor = window.__templateDrawing.texts.find(({ text }) => text === "QA MOTOR 10");
        const fontSize = Number(motor.font.match(/([\d.]+)px/)[1]);
        const glyphs = canvas.getContext("2d").getImageData(Math.floor(motor.x - 4), Math.floor(motor.y - fontSize - 4), 230, Math.ceil(fontSize + 12)).data;
        let dark = 0;
        for (let index = 0; index < glyphs.length; index += 4) if (Math.max(glyphs[index], glyphs[index + 1], glyphs[index + 2]) < 120) dark++;
        const bodyLabels = window.__templateDrawing.texts.filter(({ y }) => y > body.y && y < body.y + body.height);
        const protectedText = bodyLabels.every((label) =>
          window.__templateDrawing.strokes.some((stroke) => stroke.text === label.text && stroke.x === label.x && stroke.y === label.y && stroke.width >= 2) ||
          (label.shadowBlur >= 2 && label.shadowColor !== "rgba(0, 0, 0, 0)"));
        return { brightness: (data[0] + data[1] + data[2]) / 3, dark, protectedText };
      }, { box: thrustBox, body: geometry.videoFrame });
      assert.ok(transparent.brightness > 240, `Zero opacity must reveal the bright source instead of clamping the panel to a dark minimum: ${JSON.stringify(transparent)}`);
      assert.ok(transparent.dark > 150, `The light motor label must retain a contrasting outline on fully transparent white footage: ${JSON.stringify(transparent)}`);
      assert.equal(transparent.protectedText, true, "Labels and scales over transparent footage must keep an independent contrasting edge or shadow");
      await writeFile(join(outputDir, "templates-stacked-zero-opacity.png"), Buffer.from((await image()).split(",")[1], "base64"));
      await range("overlay-opacity", 30);
      await page.screenshot({ path: join(outputDir, "templates-stacked-desktop.png"), fullPage: true });
      await page.locator("#preview").screenshot({ path: join(outputDir, "templates-stacked-composition.png") });
    });

    await caseOf("MP4 preserves framed footage, top technical header, theory, burn markers, and default FullHD composition", async () => {
      await range("video-scale", 85); await range("video-position-x", -8); await range("video-position-y", 6);
      await page.locator("#tool-timeline").click(); await change("trim-start", 1.5); await change("trim-end", 2.5);
      await page.getByRole("tab", { name: "Export", exact: true }).click();
      assert.equal(await page.locator("#export-resolution").inputValue(), "1920");
      assert.equal(await page.locator("#export-format").inputValue(), "mp4");
      assert.equal(await page.locator("#export-quality").inputValue(), "very-high");
      await select("export-fps", "24"); await page.locator("#keep-audio").uncheck();
      await seek(2);
      const clean = await pixelDigest();
      await page.locator("#video-framing-drag").click(); await frame();
      assert.equal(await page.locator("#video-framing-guides").isVisible(), true, "The test must export while editor guides are visible");
      assert.equal(await pixelDigest(), clean, "Visible DOM guides must remain absent from the canvas used for export");
      await page.locator("#preview").evaluate((canvas) => {
        window.__templateExpected = { width: canvas.width, height: canvas.height,
          pixels: canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data };
      });
      const event = page.waitForEvent("download", { timeout: 90000 }); await page.locator("#export-button").click();
      const download = await event; assert.match(download.suggestedFilename(), /\.mp4$/);
      const path = join(outputDir, "templates-stacked.mp4"); await download.saveAs(path);
      await page.waitForFunction(() => !document.querySelector("#export-dialog").open);
      assert.equal(await page.locator("#video-framing-guides").isVisible(), false, "Export should leave movement mode and its editor-only grid");
      const input = new Input({ source: new BufferSource(await readFile(path)), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryVideoTrack(); assert.ok(track);
        assert.equal(await track.getCodec(), "avc", "Default MP4 export must contain H.264 video");
        assert.equal(await track.getDisplayWidth(), 1920); assert.equal(await track.getDisplayHeight(), 1080);
        assert.equal(await input.getPrimaryAudioTrack(), null);
        const duration = await input.computeDuration(); assert.ok(duration >= 1 && duration < 1.1);
      } finally { input.dispose(); }
      const rendered = await page.evaluate(async ({ box, header, body }) => {
        const expected = window.__templateExpected;
        const video = document.createElement("video"); video.muted = true; video.preload = "auto"; video.src = document.querySelector("#download-again").href;
        await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
        await new Promise((resolve) => { video.onseeked = resolve; video.currentTime = 0.5; });
        const canvas = document.createElement("canvas"); canvas.width = expected.width; canvas.height = expected.height;
        const context = canvas.getContext("2d"); context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let error = 0, count = 0;
        for (let index = 0; index < actual.length; index += 256) for (let channel = 0; channel < 3; channel++) {
          error += Math.abs(actual[index + channel] - expected.pixels[index + channel]); count++;
        }
        const gold = (pixels) => {
          let count = 0;
          for (let y = Math.ceil(box.y + 20); y < box.y + box.height - 10; y++) for (let x = Math.ceil(box.x); x < box.x + box.width; x++) {
            const index = (y * canvas.width + x) * 4, red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
            if (red > 90 && green > 70 && green / red > 0.76 && green / red < 0.96 && blue < green * 0.8) count++;
          }
          return count;
        };
        let headerError = 0, headerCount = 0;
        for (let y = Math.ceil(header.y); y < header.y + header.height; y += 2) for (let x = 0; x < canvas.width; x += 4) {
          const index = (y * canvas.width + x) * 4;
          for (let channel = 0; channel < 3; channel++) { headerError += Math.abs(actual[index + channel] - expected.pixels[index + channel]); headerCount++; }
        }
        // Four source corners and exposed matte make an incorrect framing
        // transform visible even when the recording's center is plain white.
        let sourceError = 0, sourceCount = 0;
        for (let y = Math.ceil(body.y + 4); y < body.y + body.height - 2; y += 8) for (let x = 0; x < 1000; x += 8) {
          const index = (y * canvas.width + x) * 4;
          for (let channel = 0; channel < 3; channel++) { sourceError += Math.abs(actual[index + channel] - expected.pixels[index + channel]); sourceCount++; }
        }
        return { error: error / count, headerError: headerError / headerCount, sourceError: sourceError / sourceCount,
          expectedGold: gold(expected.pixels), actualGold: gold(actual), frame: canvas.toDataURL("image/png") };
      }, { box: thrustBox, header: geometry.header, body: geometry.videoFrame });
      await writeFile(join(outputDir, "templates-stacked-export-frame.png"), Buffer.from(rendered.frame.split(",")[1], "base64"));
      assert.ok(rendered.error < 10, `Stacked export differs from preview by ${rendered.error}`);
      assert.ok(rendered.headerError < 10, `Exported source header differs from preview by ${rendered.headerError}`);
      assert.ok(rendered.sourceError < 8, `Exported video framing differs from preview by ${rendered.sourceError}`);
      assert.ok(rendered.expectedGold > 20 && rendered.actualGold > rendered.expectedGold * 0.3,
        `The encoded template must retain its theoretical curve: ${JSON.stringify({ ...rendered, frame: undefined })}`);
      console.log(`PASS: FullHD stacked MP4 parity (mean error ${rendered.error.toFixed(2)}, theory pixels ${rendered.actualGold})`);
    });

    await caseOf("replacing a source video restores centered framing and discards any old active placement draft", async () => {
      await page.getByRole("tab", { name: "Appearance", exact: true }).click();
      await range("video-scale", 160); await range("video-position-x", 25); await range("video-position-y", -10);
      const button = page.locator("#video-framing-drag"); await button.click();
      const rectangle = await page.locator("#preview").boundingBox(); assert.ok(rectangle);
      const x = rectangle.x + rectangle.width * 0.4, y = rectangle.y + rectangle.height * 0.5;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + rectangle.width * 0.04, y + rectangle.height * 0.02, { steps: 4 });
      await frame();
      assert.ok(Number(await page.locator("#video-position-x").inputValue()) > 25, "The old source must have an active changed placement draft");
      await page.locator("#video-input").setInputFiles({ name: "replacement-bright-source.mp4", mimeType: "video/mp4", buffer: brightVideo });
      await page.waitForFunction(() => document.querySelector("#video-source-name").textContent === "replacement-bright-source.mp4" &&
        document.querySelector("#timing-video-detail").textContent.includes("96 frames checked") &&
        !document.querySelector("#source-video").seeking && document.querySelector("#source-video").readyState >= 2);
      await page.mouse.up(); await frame();
      assert.deepEqual(await Promise.all(["video-scale", "video-position-x", "video-position-y"].map((id) => page.locator(`#${id}`).inputValue())), ["100", "0", "0"],
        "A validated replacement clip must fit completely; canceling the old draft must never restore its placement onto the new file");
      assert.equal(await page.locator("#preview").evaluate((canvas) => canvas.classList.contains("dragging")), false,
        "The replaced source must not retain an active pointer draft");
      if (await button.getAttribute("aria-pressed") === "true") await button.click();
      assert.deepEqual((await drawing()).videos.at(-1), [geometry.video.x, geometry.video.y, geometry.video.width, geometry.video.height]);
    });

    await caseOf("portrait output wraps the compact header into two readable rows without repeating categories", async () => {
      await select("frame-aspect", "portrait");
      assert.deepEqual(await page.locator("#preview").evaluate((canvas) => [canvas.width, canvas.height]), [1080, 1920]);
      const portrait = compositionGeometry(1080, 1920, 960, 540, { ...stackedStyle, frameAspect: "portrait" });
      const top = (await drawing()).texts.filter(({ y }) => y < portrait.header.y + portrait.header.height);
      assert.equal(top.length, 3);
      assert.ok(portrait.header.height <= 80, "Narrow output should use at most two compact technical rows");
      const frameLabel = top.find(({ text }) => /^Frame /.test(text));
      const logLabel = top.find(({ text }) => /^Log row /.test(text));
      const acquisition = top.find(({ text }) => /960 × 540.*fps.*VFR.*50\.0 Hz avg/.test(text));
      assert.ok(frameLabel && logLabel && acquisition);
      assert.equal(frameLabel.y, logLabel.y, "The camera and log clocks should remain side by side");
      assert.ok(acquisition.y > frameLabel.y + 16, "Acquisition details should wrap once below the two clocks");
      assert.ok(!top.some(({ text }) => /CSV|VIDEO FRAME|CSV POSITION|ACQUISITION|PTS|Δ/.test(text)));
      await writeFile(join(outputDir, "templates-stacked-portrait-header.png"), Buffer.from((await image()).split(",")[1], "base64"));
      await select("frame-aspect", "landscape");
      assert.deepEqual(await page.locator("#preview").evaluate((canvas) => [canvas.width, canvas.height]), [1920, 1080]);
    });

    await caseOf("templates remain accessible in Ukrainian and English on mobile without changing output format", async () => {
      await page.getByRole("tab", { name: "Appearance", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      for (const language of ["uk", "en"]) {
        await select("language-select", language);
        for (const id of ["presentation-layout", "chart-range", "video-scale", "video-position-x", "video-position-y", "video-framing-drag"]) {
          await reveal(page.locator(`#${id}`));
          assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} should remain available in ${language}`);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        assert.deepEqual(await page.locator("#preview").evaluate((canvas) => [canvas.width, canvas.height]), [1920, 1080]);
        assert.equal(await page.locator("#presentation-layout").inputValue(), "stacked");
        assert.equal(await page.locator("#chart-range").inputValue(), "burn");
      }
      await select("language-select", "uk");
      await page.screenshot({ path: join(outputDir, "templates-stacked-mobile.png"), fullPage: true });
      await page.locator("#video-framing-drag").click();
      assert.equal(await page.locator("#video-framing-guides").isVisible(), true);
      await select("presentation-layout", "full");
      assert.equal(await page.locator("#video-framing").isVisible(), false);
      assert.equal(await page.locator("#video-framing-drag").isVisible(), false);
      assert.equal(await page.locator("#video-framing-guides").isVisible(), false, "The grid belongs only to movement in the on-video template");
      const fullGeometry = compositionGeometry(1920, 1080, 960, 540, defaultStyle).video;
      assert.deepEqual((await drawing()).videos.at(-1), [fullGeometry.x, fullGeometry.y, fullGeometry.width, fullGeometry.height],
        "The existing full presentation must ignore the stacked template's framing values");
      assert.notDeepEqual((await drawing()).videos.at(-1), [geometry.video.x, geometry.video.y, geometry.video.width, geometry.video.height], "The existing full-frame template must remain available");
    });
  } finally { await page.close(); }
  return { failures, requests };
}
