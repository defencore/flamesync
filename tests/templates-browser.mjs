import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Input, BufferSource, ALL_FORMATS } from "mediabunny";
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
    window.__templateDrawing = { texts: [], videos: [] };
    const fillRect = CanvasRenderingContext2D.prototype.fillRect;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
      if (this.canvas.id === "preview" && x === 0 && y === 0 && width === this.canvas.width && height === this.canvas.height)
        window.__templateDrawing = { texts: [], videos: [] };
      return fillRect.call(this, x, y, width, height);
    };
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...arguments_) {
      if (this.canvas.id === "preview") {
        const point = new DOMPoint(x, y).matrixTransform(this.getTransform());
        window.__templateDrawing.texts.push({ text: String(text), x: point.x, y: point.y });
      }
      return fillText.call(this, text, x, y, ...arguments_);
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
      assert.deepEqual(await page.locator("#preview").evaluate((canvas) => [canvas.width, canvas.height]), [1920, 1080]);
    });

    // This intentionally bright source reveals panels that rely on dark footage
    // for contrast. Corner marks also make accidental cropping detectable.
    const brightVideo = await page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 540;
      const context = canvas.getContext("2d");
      const paint = () => {
        context.fillStyle = "#ffffff"; context.fillRect(0, 0, 960, 540);
        for (const [color, x, y] of [["#ff0000", 0, 0], ["#0000ff", 0, 500], ["#00ff00", 920, 0], ["#ff00ff", 920, 500]]) {
          context.fillStyle = color; context.fillRect(x, y, 40, 40);
        }
      };
      paint(); const stream = canvas.captureStream(30), chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9", videoBitsPerSecond: 1000000 });
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const done = new Promise((resolve) => { recorder.onstop = resolve; });
      const timer = setInterval(paint, 1000 / 30);
      recorder.start(); await new Promise((resolve) => setTimeout(resolve, 3200)); recorder.stop(); await done;
      clearInterval(timer); stream.getTracks().forEach((track) => track.stop());
      const buffer = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
      let binary = ""; for (const byte of buffer) binary += String.fromCharCode(byte);
      return btoa(binary);
    });
    await page.locator("#video-input").setInputFiles({ name: "bright-field-source.webm", mimeType: "video/webm", buffer: Buffer.from(brightVideo, "base64") });
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

    await caseOf("metadata and frame clocks sit over the footage while only source names stay in the footer", async () => {
      const { texts } = await drawing();
      const footerTop = geometry.sources.y;
      for (const content of ["QA MOTOR 10", "2026-10-20", "SERIES-007", "LOCAL LOGGER", "BRIGHT FIELD CAMERA"])
        assert.ok(texts.some(({ text, y }) => text.includes(content) && y < footerTop), `${content} should sit over footage`);
      for (const expression of [/^Frame /, /^CSV row /, /Burn duration.*2\.000/, /^A$/, /^B$/])
        assert.ok(texts.some(({ text, y }) => expression.test(text) && y < footerTop), `${expression} should be present over footage`);
      for (const filename of ["bright-field-source.webm", "measured-long-tail.csv"])
        assert.ok(texts.some(({ text, y }) => text.includes(filename) && y >= footerTop), `${filename} should remain in the source footer`);
      assert.ok(!texts.some(({ text, y }) => /^(Frame |CSV row )/.test(text) && y >= footerTop), "Frame and log-row data must leave the filename footer");
      assert.ok(!texts.some(({ text }) => /NaN|undefined|Infinity/.test(text)), "The video must contain valid readable values");
    });

    await caseOf("dark translucent charts retain contrast over a bright recording", async () => {
      await page.getByRole("tab", { name: "Appearance", exact: true }).click();
      assert.equal(await page.locator("#opacity-setting").isVisible(), true);
      await page.locator("#overlay-opacity").evaluate((input) => { input.value = "80"; input.dispatchEvent(new Event("input", { bubbles: true })); }); await frame();
      const contrast = await page.locator("#preview").evaluate((canvas, box) => {
        const context = canvas.getContext("2d");
        const data = context.getImageData(Math.round(box.x + 5), Math.round(box.y + 20), 10, 10).data;
        const brightness = (data[0] + data[1] + data[2]) / 3;
        const outside = context.getImageData(500, 300, 1, 1).data;
        return { brightness, outside: (outside[0] + outside[1] + outside[2]) / 3 };
      }, thrustBox);
      assert.ok(contrast.outside > 240, `The synthetic recording should remain bright: ${JSON.stringify(contrast)}`);
      assert.ok(contrast.brightness > 20 && contrast.brightness < 115, `The panel should darken bright footage without becoming fully opaque: ${JSON.stringify(contrast)}`);
      await page.screenshot({ path: join(outputDir, "templates-stacked-desktop.png"), fullPage: true });
      await page.locator("#preview").screenshot({ path: join(outputDir, "templates-stacked-composition.png") });
    });

    await caseOf("MP4 preserves the stacked template, theory, burn markers, and default FullHD composition", async () => {
      await page.locator("#tool-timeline").click(); await change("trim-start", 1.5); await change("trim-end", 2.5);
      await page.getByRole("tab", { name: "Export", exact: true }).click();
      assert.equal(await page.locator("#export-resolution").inputValue(), "1920");
      await select("export-format", "mp4"); await select("export-fps", "24"); await page.locator("#keep-audio").uncheck();
      await seek(2);
      await page.locator("#preview").evaluate((canvas) => {
        window.__templateExpected = { width: canvas.width, height: canvas.height,
          pixels: canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data };
      });
      const event = page.waitForEvent("download", { timeout: 90000 }); await page.locator("#export-button").click();
      const download = await event; const path = join(outputDir, "templates-stacked.mp4"); await download.saveAs(path);
      await page.waitForFunction(() => !document.querySelector("#export-dialog").open);
      const input = new Input({ source: new BufferSource(await readFile(path)), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryVideoTrack(); assert.ok(track);
        assert.equal(await track.getDisplayWidth(), 1920); assert.equal(await track.getDisplayHeight(), 1080);
        assert.equal(await input.getPrimaryAudioTrack(), null);
        const duration = await input.computeDuration(); assert.ok(duration >= 1 && duration < 1.1);
      } finally { input.dispose(); }
      const rendered = await page.evaluate(async (box) => {
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
        return { error: error / count, expectedGold: gold(expected.pixels), actualGold: gold(actual), frame: canvas.toDataURL("image/png") };
      }, thrustBox);
      await writeFile(join(outputDir, "templates-stacked-export-frame.png"), Buffer.from(rendered.frame.split(",")[1], "base64"));
      assert.ok(rendered.error < 10, `Stacked export differs from preview by ${rendered.error}`);
      assert.ok(rendered.expectedGold > 20 && rendered.actualGold > rendered.expectedGold * 0.3,
        `The encoded template must retain its theoretical curve: ${JSON.stringify({ ...rendered, frame: undefined })}`);
      console.log(`PASS: FullHD stacked MP4 parity (mean error ${rendered.error.toFixed(2)}, theory pixels ${rendered.actualGold})`);
    });

    await caseOf("templates remain accessible in Ukrainian and English on mobile without changing output format", async () => {
      await page.getByRole("tab", { name: "Appearance", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      for (const language of ["uk", "en"]) {
        await select("language-select", language);
        for (const id of ["presentation-layout", "chart-range"])
          assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} should remain available in ${language}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        assert.deepEqual(await page.locator("#preview").evaluate((canvas) => [canvas.width, canvas.height]), [1920, 1080]);
        assert.equal(await page.locator("#presentation-layout").inputValue(), "stacked");
        assert.equal(await page.locator("#chart-range").inputValue(), "burn");
      }
      await select("language-select", "uk");
      await page.screenshot({ path: join(outputDir, "templates-stacked-mobile.png"), fullPage: true });
      await select("presentation-layout", "full");
      assert.notDeepEqual((await drawing()).videos.at(-1), [geometry.video.x, geometry.video.y, geometry.video.width, geometry.video.height], "The existing full-frame template must remain available");
    });
  } finally { await page.close(); }
  return { failures, requests };
}
