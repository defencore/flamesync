import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compositionGeometry } from "../src/composition-layout.js";
import { defaultStyle } from "../src/overlay.js";

const preferenceKey = "flamesync.preferences";
const languageKey = "flamesync.language";
const measuredName = "PRIVATE-PREFERENCE-VIDEO-LOG.csv";
const theoryName = "PRIVATE-PREFERENCE-THEORY.csv";
const profileName = "PRIVATE-PREFERENCE-PROFILE.csv";
const videoName = "PRIVATE-PREFERENCE-VIDEO.mp4";
const triangle = (name, unit = "us") => ({ name, mimeType: "text/csv", buffer: Buffer.from(
  `time_${unit};thrust;pressure\n0;0;0\n${unit === "us" ? 1000000 : 1000};10;100\n${unit === "us" ? 2000000 : 2000};0;0`) });

const defaults = {
  "language-select": "uk", "meta-motor": "", "meta-testDate": "", "meta-logger": "", "meta-notes": "",
  "presentation-layout": "full", "chart-range": "burn", "frame-aspect": "landscape", "test-title": "STATIC FIRE TEST",
  "video-scale": "100", "video-position-x": "0", "video-position-y": "0", "overlay-opacity": "78", "overlay-height": "25",
  "thrust-unit": "kgf", "pressure-unit": "bar", "show-pressure": true, "show-impulse": false,
  "export-format": "mp4", "export-resolution": "1920", "export-quality": "very-high", "export-fps": "0", "keep-audio": true,
  "csv-time-unit": "auto", "source-thrust-unit": "kgf", "source-pressure-unit": "bar",
  "profiles-source-time": "auto", "profiles-source-thrust": "kgf", "profiles-source-pressure": "bar",
  "profiles-threshold": "5", "profiles-noise-window": "100", "profiles-alignment": "ignition", "profiles-trace": "raw",
  "profiles-thrust-unit": "kgf", "profiles-pressure-unit": "bar", "series-name": "", "series-band": "sd", "series-show-profiles": false,
  "theory-time-unit": "auto", "theory-thrust-unit": "kgf", "theory-pressure-unit": "bar", "theory-alignment": "ignition", "theory-enabled": true,
  "measure-threshold": "5", "show-measurement": true, "playback-rate": "1",
};

/** Verify reusable preferences without persisting any project media or timing. */
export async function verifyPreferences({ browser, baseURL, outputDir }) {
  const failures = [], requests = [];
  const mediaModule = await readFile(new URL("../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs", import.meta.url), "utf8");
  let videoFixture;
  const frame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const values = (page, ids) => page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
    const input = document.getElementById(id);
    return [id, input.type === "checkbox" ? input.checked : input.value];
  })), ids);
  const expectValues = async (page, expected, message) => assert.deepEqual(await values(page, Object.keys(expected)), expected, message);
  const expose = async (page, id) => {
    const input = page.locator(`#${id}`);
    const workspace = await input.evaluate((node) => node.closest("#profile-analysis") ? "analysis" : node.closest("#video-editor") ? "video" : null);
    if (workspace) await page.locator(`#mode-${workspace}`).click();
    const inspector = await input.evaluate((node) => node.closest(".inspector-content")?.id);
    if (inspector) await page.locator(`#tab-${inspector.replace("panel-", "")}`).click();
    if (await input.evaluate((node) => Boolean(node.closest("#measurement-panel")))) await page.locator("#tool-measurement").click();
    if (await input.evaluate((node) => Boolean(node.closest("#timeline-panel")))) await page.locator("#tool-timeline").click();
    if (id.startsWith("series-")) await page.locator("#profiles-mode").selectOption("series");
    await input.locator("xpath=ancestor::details").evaluateAll((details) => details.forEach((element) => { element.open = true; }));
    return input;
  };
  const change = async (page, id, value) => {
    const input = await expose(page, id);
    const tag = await input.evaluate((node) => node.tagName.toLowerCase());
    const type = await input.getAttribute("type");
    if (tag === "select") await input.selectOption(String(value));
    else if (type === "checkbox") await input.setChecked(Boolean(value));
    else if (type === "range") await input.evaluate((node, value) => {
      node.value = String(value); node.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    else { await input.fill(String(value)); await input.press("Tab"); }
    await frame(page);
  };
  const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), preferenceKey);
  const waitStored = (page, id, value) => page.waitForFunction(({ key, id, value }) => {
    try { return JSON.parse(localStorage.getItem(key))?.values?.[id] === value; } catch { return false; }
  }, { key: preferenceKey, id, value });
  const uploadVideo = async (page, name = videoName) => {
    if (!videoFixture) videoFixture = Buffer.from(await page.evaluate(async () => {
      const { Output, BufferTarget, Mp4OutputFormat, CanvasSource } = await import(`${location.origin}/__qa__/preferences-media.mjs`);
      const canvas = new OffscreenCanvas(320, 180), context = canvas.getContext("2d");
      const target = new BufferTarget(), output = new Output({ target, format: new Mp4OutputFormat() });
      const source = new CanvasSource(canvas, { codec: "avc", bitrate: 200000 });
      output.addVideoTrack(source, { frameRate: 10 }); await output.start();
      for (let index = 0; index < 30; index++) {
        context.fillStyle = "#ccd8d5"; context.fillRect(0, 0, 320, 180);
        context.fillStyle = "#314949"; context.fillRect(148, 72, 24, 108);
        await source.add(index / 10, .1);
      }
      source.close(); await output.finalize(); return Array.from(new Uint8Array(target.buffer));
    }));
    await page.locator("#video-input").setInputFiles({ name, mimeType: "video/mp4", buffer: videoFixture });
    await page.waitForFunction((name) => document.querySelector("#video-source-name").textContent === name &&
      document.querySelector("#timing-video-detail").textContent.includes("30 frames checked") &&
      document.querySelector("#source-video").readyState >= 2, name);
    await frame(page);
  };
  const uploadLog = async (page) => {
    await page.locator("#csv-input").setInputFiles(triangle(measuredName));
    await page.waitForFunction((name) => document.querySelector("#csv-filename").textContent === name &&
      !document.querySelector("#measure-start").disabled, measuredName);
    await frame(page);
  };
  const seek = async (page, time) => {
    await page.locator("#scrubber").evaluate((input, value) => {
      input.value = String(value); input.dispatchEvent(new Event("input", { bubbles: true }));
    }, time);
    await page.waitForFunction((time) => !document.querySelector("#source-video").seeking &&
      Math.abs(document.querySelector("#source-video").currentTime - time) < .002, time);
    await frame(page);
  };
  const caseOf = async (name, run, init) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: "en-US" });
    page.on("pageerror", (error) => failures.push(`Preferences: ${error.message}`));
    page.on("console", (entry) => { if (entry.type() === "error") failures.push(`Preferences: ${entry.text()}`); });
    page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
    await page.route("**/__qa__/preferences-media.mjs", (route) => route.fulfill({ contentType: "text/javascript", body: mediaModule }));
    await page.addInitScript(() => {
      window.__preferenceExportJobs = [];
      const postMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (job, ...arguments_) {
        if (job?.file && ["mp4", "webm"].includes(job.format)) {
          window.__preferenceExportJobs.push({
            name: job.theory?.name, offset: job.theory?.offset,
            timeScale: job.theory?.timeScale, measurement: job.measurement,
          });
        }
        return postMessage.call(this, job, ...arguments_);
      };
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (source, ...bounds) {
        if (this.canvas.id === "preview" && source instanceof HTMLVideoElement && bounds.length === 4) window.__preferenceVideoBounds = bounds;
        return drawImage.call(this, source, ...bounds);
      };
    });
    try {
      if (init) await init(page);
      await page.goto(baseURL); await frame(page);
      await run(page); console.log(`PASS: ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error.stack || error.message || String(error)}`);
      await page.screenshot({ path: join(outputDir, `preferences-failure-${failures.length}.png`), fullPage: true }).catch(() => {});
    } finally { await page.close(); }
  };

  await caseOf("reusable editor, export, analysis, and theory settings survive reload while files and project clocks remain private", async (page) => {
    await expectValues(page, defaults, "Fresh settings must use the documented factory defaults");
    await change(page, "language-select", "en");
    for (const [id, value] of Object.entries({ "csv-time-unit": "us", "source-thrust-unit": "N", "source-pressure-unit": "kPa" })) await change(page, id, value);
    await uploadVideo(page); await uploadLog(page);
    await expose(page, "presentation-layout");
    await page.locator('[data-theme="light"]').click(); await page.locator('[data-trace="live"]').click();
    const expected = {
      "language-select": "en", "meta-motor": "PREFERENCE MOTOR", "meta-testDate": "2026-10-20", "meta-logger": "Reusable logger", "meta-notes": "Reusable recording notes",
      "show-impulse": true,
      "presentation-layout": "stacked", "chart-range": "full", "frame-aspect": "portrait", "test-title": "REUSABLE TEST",
      "video-scale": "125", "video-position-x": "-14", "video-position-y": "9", "overlay-opacity": "0",
      "thrust-unit": "lbf", "pressure-unit": "psi", "show-pressure": false,
      "export-format": "webm", "export-resolution": "1280", "export-quality": "medium", "export-fps": "60", "keep-audio": false,
      "csv-time-unit": "us", "source-thrust-unit": "N", "source-pressure-unit": "kPa",
      "profiles-source-time": "us", "profiles-source-thrust": "N", "profiles-source-pressure": "kPa",
      "profiles-threshold": "20", "profiles-noise-window": "250", "profiles-alignment": "burnout", "profiles-trace": "residual",
      "profiles-thrust-unit": "N", "profiles-pressure-unit": "kPa", "series-name": "REUSABLE SERIES", "series-band": "range", "series-show-profiles": true,
      "theory-time-unit": "ms", "theory-thrust-unit": "N", "theory-pressure-unit": "kPa", "theory-alignment": "burnout", "theory-enabled": false,
      "measure-threshold": "12", "show-measurement": false, "playback-rate": "0.5",
    };
    for (const [id, value] of Object.entries(expected)) await change(page, id, value);
    await change(page, "series-metric", "peakPressure");
    await change(page, "profiles-mode", "comparison");
    await page.locator("#profiles-input").setInputFiles(triangle(profileName));
    await page.waitForFunction(() => document.querySelectorAll("#profiles-list .profile-card").length === 1 && document.querySelector("#profile-analysis").getAttribute("aria-busy") !== "true");
    await page.locator("#theory-input").setInputFiles(triangle(theoryName, "ms"));
    await page.waitForFunction((name) => document.querySelector("#theory-name").textContent === name && document.querySelector("#theory-panel").getAttribute("aria-busy") !== "true", theoryName);
    await change(page, "theory-start", .3); await change(page, "theory-end", 1.7);
    await change(page, "theory-offset", .456); await change(page, "theory-scale", 155);
    await change(page, "measure-start", .25); await change(page, "measure-end", 1.75);
    await change(page, "trim-start", .2); await change(page, "trim-end", 1.9); await change(page, "sync-offset", .125);
    await seek(page, 1);
    await waitStored(page, "series-metric", "peakPressure");
    const saved = await stored(page); assert.equal(saved.version, 1);
    assert.equal(saved.values.theme, "light"); assert.equal(saved.values.trace, "live");
    const serialized = JSON.stringify(saved);
    for (const name of [videoName, measuredName, theoryName, profileName]) assert.ok(!serialized.includes(name), `${name} must never enter saved preferences`);
    for (const token of ["blob:", "data:video", "time_us;thrust", "theory-offset", "theory-scale", "theory-start", "theory-end", "sync-offset", "trim-start", "trim-end", "measure-start", "measure-end"])
      assert.ok(!serialized.includes(token), `${token} is project data rather than a reusable preference`);
    expected["meta-notes"] = "Final note before immediate reload";
    await (await expose(page, "meta-notes")).fill(expected["meta-notes"]);
    await page.reload(); await frame(page);
    await expectValues(page, expected, "Saved controls must hydrate actual application settings across reload");
    assert.equal(await page.locator("#series-metric").inputValue(), "peakPressure", "A dynamically populated analysis selector must restore after its options exist");
    assert.equal(await page.locator('[data-theme="light"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('[data-trace="live"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("input[type=file]").evaluateAll((inputs) => inputs.every((input) => input.files.length === 0)), true);
    assert.equal(await page.locator("#source-video").evaluate((video) => video.currentSrc), "");
    assert.equal(await page.locator("#profiles-list .profile-card").count(), 0);
    assert.equal(await page.locator("#theory-name").textContent(), "");
    assert.equal(Number(await page.locator("#trim-start").inputValue()), 0);
    assert.equal(Number(await page.locator("#sync-offset").inputValue()), 0);
    await expectValues(page, { "theory-offset": "0", "theory-scale": "100", "measure-start": "", "measure-end": "", "theory-start": "", "theory-end": "" });
    await uploadVideo(page, "NEW-PRIVATE-FIRST-IMPORT.mp4");
    assert.equal(await page.locator("#source-video").evaluate((video) => video.playbackRate), .5);
    const rectangle = compositionGeometry(1080, 1920, 320, 180, { ...defaultStyle, layout: "stacked", frameAspect: "portrait", videoScale: 125, videoX: -14, videoY: 9 }).video;
    assert.deepEqual(await page.evaluate(() => window.__preferenceVideoBounds), [rectangle.x, rectangle.y, rectangle.width, rectangle.height], "The first new clip must use restored framing in the actual composition");
    await page.locator("#mode-analysis").click();
    await page.locator("#profiles-input").setInputFiles(triangle("NEW-PRIVATE-ANALYSIS.csv"));
    await page.waitForFunction(() => document.querySelectorAll("#profiles-list .profile-card").length === 1 && document.querySelector("#profile-analysis").getAttribute("aria-busy") !== "true");
    const card = page.locator("#profiles-list .profile-card").first();
    assert.ok(Math.abs(Number(await card.locator('[data-field="start"]').inputValue()) - .2) < 0.000001, "Restored threshold must affect new calculations, not just the input label");
    assert.ok(Math.abs(Number(await card.locator('[data-field="end"]').inputValue()) - 1.8) < 0.000001);
    await page.locator("#mode-video").click();
    await page.screenshot({ path: join(outputDir, "preferences-restored-desktop.png"), fullPage: true });
  });

  await caseOf("clearing settings restores factory defaults in place and preserves unrelated browser storage", async (page) => {
    await change(page, "language-select", "en"); await change(page, "meta-motor", "RESET THIS MODEL");
    await change(page, "export-format", "webm"); await change(page, "export-quality", "medium");
    await change(page, "profiles-threshold", 20); await change(page, "theory-thrust-unit", "N");
    await waitStored(page, "meta-motor", "RESET THIS MODEL");
    await page.evaluate(() => localStorage.setItem("unrelated.browser.preference", "keep"));
    const navigation = page.url();
    await page.locator("#clear-settings").click(); await frame(page);
    assert.equal(page.url(), navigation, "Reset should not navigate or reload the page");
    await expectValues(page, defaults);
    assert.equal(await page.locator('[data-theme="dark"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('[data-trace="full"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), preferenceKey), null);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), languageKey), null);
    assert.equal(await page.evaluate(() => localStorage.getItem("unrelated.browser.preference")), "keep");
    await page.reload(); await frame(page); await expectValues(page, defaults);
    for (const language of ["en", "uk"]) {
      await change(page, "language-select", language); await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => window.scrollTo(0, 0)); await frame(page);
      const button = await page.locator("#clear-settings").boundingBox(); assert.ok(button);
      assert.ok(button.x >= 0 && button.x + button.width <= 390 && button.y >= 0 && button.y + button.height <= 150, "Clear settings must remain accessible at the top on mobile in both languages");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    }
    await page.screenshot({ path: join(outputDir, "preferences-mobile-header.png"), fullPage: false });
  });

  await caseOf("clearing reusable preferences preserves loaded files, original sensor units, and project synchronization", async (page) => {
    await change(page, "language-select", "en");
    for (const [id, value] of Object.entries({ "csv-time-unit": "us", "source-thrust-unit": "N", "source-pressure-unit": "kPa", "theory-time-unit": "ms", "theory-thrust-unit": "N", "theory-pressure-unit": "kPa" })) await change(page, id, value);
    await uploadVideo(page); await uploadLog(page);
    await page.locator("#theory-input").setInputFiles(triangle(theoryName, "ms"));
    await page.waitForFunction((name) => document.querySelector("#theory-name").textContent === name && document.querySelector("#theory-panel").getAttribute("aria-busy") !== "true", theoryName);
    for (const [id, value] of Object.entries({ "theory-start": .3, "theory-end": 1.7, "theory-offset": .456, "theory-scale": 155, "measure-start": .25, "measure-end": 1.75, "trim-start": .2, "trim-end": 1.9, "sync-offset": .125, "meta-motor": "RESET ACTIVE MODEL" })) await change(page, id, value);
    await change(page, "theory-alignment", "both");
    await seek(page, 1);
    const projectIds = ["trim-start", "trim-end", "sync-offset", "measure-start", "measure-end", "csv-time-unit", "source-thrust-unit", "source-pressure-unit", "theory-start", "theory-end", "theory-offset", "theory-scale", "theory-alignment", "theory-time-unit", "theory-thrust-unit", "theory-pressure-unit"];
    const exportMapping = async () => {
      const count = await page.evaluate(() => window.__preferenceExportJobs.length);
      await page.locator("#tab-export").click();
      await page.locator("#export-button").click();
      await page.waitForFunction((count) => window.__preferenceExportJobs.length > count, count);
      const job = await page.evaluate(() => window.__preferenceExportJobs.at(-1));
      if (await page.locator("#export-dialog").evaluate((dialog) => dialog.open)) await page.locator("#cancel-export").click();
      await page.waitForFunction(() => !document.querySelector("#export-dialog").open && !document.querySelector("#clear-settings").disabled);
      await frame(page);
      return job;
    };
    const mapping = await exportMapping();
    assert.equal(mapping.name, theoryName);
    assert.ok(Math.abs(mapping.timeScale - (1.75 - .25) / (1.7 - .3) * 1.55) < 1e-9, "The worker must receive the actual two-event duration mapping");
    assert.ok(Math.abs(mapping.offset - (.25 - .3 * mapping.timeScale + .456)) < 1e-9, "The worker must receive the actual two-event offset");
    const before = await values(page, projectIds);
    const media = await page.locator("#source-video").evaluate((video) => ({ src: video.currentSrc, time: video.currentTime }));
    await page.locator("#clear-settings").click(); await frame(page);
    await expectValues(page, before, "Clearing future defaults must not reinterpret existing sensor data or change selected events");
    assert.deepEqual(await page.locator("#source-video").evaluate((video) => ({ src: video.currentSrc, time: video.currentTime })), media);
    assert.equal(await page.locator("#csv-filename").textContent(), measuredName);
    assert.equal(await page.locator("#theory-name").textContent(), theoryName);
    await expectValues(page, { "meta-motor": "", "export-format": "mp4", "export-resolution": "1920", "export-quality": "very-high", "language-select": "uk" });
    assert.deepEqual(await exportMapping(), mapping, "Clearing reusable settings must preserve the effective theory clock mapping sent to the encoder");
    const nextLog = { name: "FUTURE-FACTORY-LOG.csv", mimeType: "text/csv", buffer: Buffer.from("time_ms;thrust;pressure\n0;0;0\n1000;10;1\n2000;0;0") };
    await page.locator("#csv-input").setInputFiles(nextLog);
    await page.waitForFunction((name) => document.querySelector("#csv-filename").textContent === name && document.querySelector("#csv-drop").getAttribute("aria-busy") !== "true", nextLog.name);
    await expectValues(page, { "csv-time-unit": "auto", "source-thrust-unit": "kgf", "source-pressure-unit": "bar" }, "The next log must use factory defaults rather than the preserved old file's units");
    assert.equal(Number.parseFloat(await page.locator("#summary-thrust").textContent()), 10, "A new ten-kilogram-force log must not inherit the previous Newton calibration");
    const nextTheory = { ...nextLog, name: "FUTURE-FACTORY-THEORY.csv" };
    await page.locator("#theory-input").setInputFiles(nextTheory);
    await page.waitForFunction((name) => document.querySelector("#theory-name").textContent === name && document.querySelector("#theory-panel").getAttribute("aria-busy") !== "true", nextTheory.name);
    await expectValues(page, { "theory-time-unit": "auto", "theory-thrust-unit": "kgf", "theory-pressure-unit": "bar", "theory-alignment": "ignition" }, "The next theoretical file must also use factory input units and alignment");
    await page.reload(); await frame(page);
    await expectValues(page, { "csv-time-unit": "auto", "source-thrust-unit": "kgf", "source-pressure-unit": "bar", "theory-time-unit": "auto", "theory-thrust-unit": "kgf", "theory-pressure-unit": "bar", "theory-alignment": "ignition" }, "Future imports after clearing must return to factory units and alignment");
  });

  await caseOf("malformed, unsupported, and invalid stored preferences cannot break initialization or restore project data", async (page) => {
    for (const payload of ["{broken", JSON.stringify({ version: 999, values: { "meta-motor": "UNSUPPORTED MODEL" } }), JSON.stringify({ version: 1, values: {
      "presentation-layout": "invalid-layout", "export-quality": "unavailable", "video-scale": "99999", "show-pressure": "false", "meta-motor": {},
      "profiles-threshold": "0x14", "profiles-noise-window": " 100 ", "overlay-height": "25.",
      "trim-start": "99", "sync-offset": "123", "videoURL": "blob:PRIVATE-URL", "data": [{ thrust: 999 }],
    } })]) {
      await page.evaluate(({ key, payload }) => { localStorage.removeItem("flamesync.language"); localStorage.setItem(key, payload); }, { key: preferenceKey, payload });
      await page.reload(); await frame(page);
      await expectValues(page, { "presentation-layout": "full", "export-quality": "very-high", "video-scale": "100", "show-pressure": true, "meta-motor": "", "profiles-threshold": "5", "profiles-noise-window": "100", "overlay-height": "25" });
      assert.equal(Number(await page.locator("#trim-start").inputValue()), 0);
      assert.equal(Number(await page.locator("#sync-offset").inputValue()), 0);
      assert.equal(await page.locator("#source-video").evaluate((video) => video.currentSrc), "");
      assert.equal(await page.locator("#export-button").isDisabled(), true);
    }
  });

  await caseOf("clearing settings is unavailable while an imported log is still processing", async (page) => {
    await change(page, "language-select", "en"); await change(page, "meta-motor", "KEEP WHILE PROCESSING");
    await waitStored(page, "meta-motor", "KEEP WHILE PROCESSING");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const workerRoute = async (route) => { await gate; await route.continue(); };
    await page.route("**/*csv-worker*.js", workerRoute);
    try {
      await page.locator("#csv-input").setInputFiles(triangle(measuredName, "ms"));
      await page.waitForFunction(() => document.querySelector("#csv-drop").getAttribute("aria-busy") === "true" && document.querySelector("#clear-settings").disabled);
      assert.equal(await page.locator("#clear-settings").isDisabled(), true);
      assert.equal(await page.locator("#meta-motor").inputValue(), "KEEP WHILE PROCESSING");
      release();
      await page.waitForFunction(() => document.querySelector("#csv-drop").getAttribute("aria-busy") !== "true" && !document.querySelector("#clear-settings").disabled);
    } finally { release(); await page.unroute("**/*csv-worker*.js", workerRoute); }
  });

  await caseOf("unit edits after a rejected replacement target the visible valid source and become future defaults only after success", async (page) => {
    await change(page, "language-select", "en"); await change(page, "source-thrust-unit", "kgf");
    await waitStored(page, "source-thrust-unit", "kgf");
    const validLog = { name: "VALID-BEFORE-FAILED-UNITS.csv", mimeType: "text/csv", buffer: Buffer.from("time_ms;thrust;pressure\n0;0;0\n1000;10;1\n2000;0;0") };
    await page.locator("#csv-input").setInputFiles(validLog);
    await page.waitForFunction((name) => document.querySelector("#csv-filename").textContent === name && document.querySelector("#csv-drop").getAttribute("aria-busy") !== "true", validLog.name);
    assert.equal(Number.parseFloat(await page.locator("#summary-thrust").textContent()), 10);
    await page.locator("#csv-input").setInputFiles({ name: "INVALID-REPLACEMENT.csv", mimeType: "text/csv", buffer: Buffer.from("time_ms;thrust;pressure\n0;0;0\n0;10;1") });
    await page.waitForFunction(() => document.querySelector("#notice").className === "error" && document.querySelector("#csv-drop").getAttribute("aria-busy") !== "true");
    assert.equal(await page.locator("#csv-filename").textContent(), validLog.name, "A rejected replacement must keep the visible active file");
    assert.equal(await page.locator("#source-thrust-unit").inputValue(), "kgf");
    assert.equal(Number.parseFloat(await page.locator("#summary-thrust").textContent()), 10);
    assert.equal((await stored(page)).values["source-thrust-unit"], "kgf", "A failed replacement cannot change saved import units");
    await change(page, "source-thrust-unit", "N");
    await page.waitForFunction(() => document.querySelector("#csv-drop").getAttribute("aria-busy") !== "true" && document.querySelector("#source-thrust-unit").value === "N" &&
      Math.abs(Number.parseFloat(document.querySelector("#summary-thrust").textContent) - 10 / 9.80665) < .001);
    assert.equal(await page.locator("#csv-filename").textContent(), validLog.name, "Unit selectors must reparse the visible valid file rather than retry a hidden rejected replacement");
    await waitStored(page, "source-thrust-unit", "N");
    const saved = await stored(page);
    assert.equal(saved.values["source-thrust-unit"], "N", "Validated active-source units become future defaults");
    assert.ok(!JSON.stringify(saved).includes(validLog.name) && !JSON.stringify(saved).includes("INVALID-REPLACEMENT.csv"), "Neither active nor rejected file identities may enter preferences");
    await page.reload(); await frame(page);
    assert.equal(await page.locator("#source-thrust-unit").inputValue(), "N");
    assert.equal(await page.locator("#csv-drop").evaluate((node) => node.classList.contains("loaded")), false, "Reload must retain preferences without retaining the source file");
    const nextLog = { ...validLog, name: "VALID-AFTER-FAILED-UNITS.csv" };
    await page.locator("#csv-input").setInputFiles(nextLog);
    await page.waitForFunction((name) => document.querySelector("#csv-filename").textContent === name && document.querySelector("#csv-drop").getAttribute("aria-busy") !== "true", nextLog.name);
    assert.equal(await page.locator("#source-thrust-unit").inputValue(), "N");
    assert.ok(Math.abs(Number.parseFloat(await page.locator("#summary-thrust").textContent()) - 10 / 9.80665) < .001, "The next raw ten-unit log must use the successfully saved Newton source unit");
  });

  await caseOf("a rejected conversion of the active source cannot overwrite validated unit preferences", async (page) => {
    await change(page, "language-select", "en"); await change(page, "source-thrust-unit", "kgf");
    await waitStored(page, "source-thrust-unit", "kgf");
    const largeLog = { name: "VALID-CONVERSION-BOUNDARY.csv", mimeType: "text/csv", buffer: Buffer.from("time_ms;thrust;pressure\n0;0;0\n1;1e306;1\n2;0;0") };
    await page.locator("#csv-input").setInputFiles(largeLog);
    await page.waitForFunction((name) => document.querySelector("#csv-filename").textContent === name && document.querySelector("#csv-drop").getAttribute("aria-busy") !== "true", largeLog.name);
    const peak = await page.locator("#summary-thrust").textContent();
    await change(page, "source-thrust-unit", "kN");
    await page.waitForFunction(() => document.querySelector("#notice").className === "error" && document.querySelector("#csv-drop").getAttribute("aria-busy") !== "true" && document.querySelector("#source-thrust-unit").value === "kgf");
    assert.equal(await page.locator("#csv-filename").textContent(), largeLog.name);
    assert.equal(await page.locator("#summary-thrust").textContent(), peak, "Rejected overflow must preserve the actual valid source values");
    await change(page, "meta-motor", "AFTER REJECTED CONVERSION"); await waitStored(page, "meta-motor", "AFTER REJECTED CONVERSION");
    const saved = await stored(page);
    assert.equal(saved.values["source-thrust-unit"], "kgf", "A failed active-source conversion cannot become the next file's default");
    assert.ok(!JSON.stringify(saved).includes(largeLog.name) && !JSON.stringify(saved).includes("1e306"), "Source identities and samples remain private");
    await page.reload(); await frame(page);
    assert.equal(await page.locator("#source-thrust-unit").inputValue(), "kgf");
  });

  for (const blocked of ["read", "write"]) await caseOf(`the editor remains usable when preference storage ${blocked === "read" ? "is unavailable" : "has no space"}`, async (page) => {
    await expectValues(page, defaults);
    await change(page, "language-select", "en"); await change(page, "meta-motor", "UNSAVED MODEL");
    await change(page, "export-quality", "medium");
    await expectValues(page, { "language-select": "en", "meta-motor": "UNSAVED MODEL", "export-quality": "medium" });
    await page.locator("#clear-settings").click(); await frame(page);
    await expectValues(page, defaults);
    await page.reload(); await frame(page); await expectValues(page, defaults);
  }, async (page) => page.addInitScript((blocked) => {
    if (blocked === "read") Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("Storage blocked", "SecurityError"); } });
    else Storage.prototype.setItem = function () { throw new DOMException("Storage full", "QuotaExceededError"); };
  }, blocked));

  return { failures, requests };
}
