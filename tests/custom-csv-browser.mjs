import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Synthetic CSV and video fixtures are constructed in memory. No recordings,
// log samples, filenames, or schemas are sent to a server or added to the site.
const file = (name, text) => ({ name, mimeType: "text/csv", buffer: Buffer.from(text) });
const headers = "clock_force;load;clock_pressure;chamber;burning;start_flag;end_flag;other_pressure;clock_shift";
function custom(name = "PRIVATE-CUSTOM-LOG.csv", { offset = 0, header = true, events = false } = {}) {
  const pressureTimes = [0, 1.4, 1.5, 1.6, 4];
  const rows = [0, 1, 2, 3, 4].map((time, index) => [
    (offset + time) * 1000, [0, 10, 10, 0, 0][index],
    (offset + pressureTimes[index]) * 1000000, [0, 0, 90, 0, 0][index],
    events ? ["false", "true", "true", "false", "false"][index] : [0, 1, 1, 0, 0][index],
    events ? ["false", "true", "false", "false", "false"][index] : [0, 1, 0, 0, 0][index],
    events ? ["false", "false", "false", "true", "false"][index] : [0, 0, 0, 1, 0][index],
    [0, 2, 4, 2, 0][index], (offset + time + 5) * 1000,
  ].join(";"));
  return file(name, [...(header ? [headers] : []), ...rows].join("\n"));
}
const standard = () => file("PRIVATE-STANDARD.csv", "time_ms;thrust;pressure\n0;0;0\n1000;10;2\n2000;10;2\n3000;0;0");
const closeTo = (actual, expected, message, tolerance = 1e-6) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
  `${message}: ${actual} should equal ${expected} ± ${tolerance}`);

/** Exercise custom column selection through public controls and worker outputs. */
export async function verifyCustomCSV({ browser, baseURL, outputDir }) {
  const failures = [], requests = [];
  const mediaModule = await readFile(new URL("../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs", import.meta.url), "utf8");
  let videoFixture;
  const frame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const settle = async (page) => {
    await frame(page);
    await page.waitForFunction(() => document.querySelector("#profile-analysis").getAttribute("aria-busy") !== "true" &&
      document.querySelector("#theory-panel").getAttribute("aria-busy") !== "true" && !document.querySelector("#clear-settings").disabled);
    await frame(page);
  };
  const reveal = async (input) => {
    await input.locator("xpath=ancestor::details").evaluateAll((ancestors) => ancestors.forEach((node) => { node.open = true; }));
  };
  const change = async (page, id, value) => {
    const input = page.locator(`#${id}`); await reveal(input);
    await input.fill(String(value)); await input.press("Tab"); await frame(page);
  };
  const select = async (page, id, value) => {
    const input = page.locator(`#${id}`); await reveal(input);
    await input.selectOption(String(value)); await frame(page);
  };
  const mapped = async (page, { pressure = "3", pressureTime = "2", mode = "active", header = true, thrustTime = "0", timeUnit = "ms" } = {}) => {
    await page.locator("#csv-mapping-dialog").waitFor({ state: "visible" });
    await page.locator("#csv-map-header").setChecked(header);
    await select(page, "csv-map-thrust-time", thrustTime);
    await select(page, "csv-map-thrust", "1");
    await select(page, "csv-map-time-unit", timeUnit);
    await select(page, "csv-map-thrust-unit", "kgf");
    await select(page, "csv-map-pressure", pressure);
    if (pressure !== "") {
      await select(page, "csv-map-pressure-time", pressureTime);
      if (pressureTime !== "") await select(page, "csv-map-pressure-time-unit", "us");
      await select(page, "csv-map-pressure-unit", "bar");
    }
    await select(page, "csv-map-marker-mode", mode);
    if (mode === "active") await select(page, "csv-map-active", "4");
    if (mode === "events") { await select(page, "csv-map-start", "5"); await select(page, "csv-map-end", "6"); }
    await page.locator("#csv-map-apply").click();
    await page.locator("#csv-mapping-dialog").waitFor({ state: "hidden" });
    await settle(page);
  };
  const upload = async (page, source, options = {}) => {
    await page.locator("#csv-input").setInputFiles(source); await mapped(page, options);
    await page.waitForFunction((name) => document.querySelector("#csv-filename").textContent === name &&
      !document.querySelector("#measure-start").disabled, source.name); await frame(page);
  };
  const lastData = (page) => page.evaluate(() => [...window.__customWorkerMessages].reverse().find((entry) => entry.data?.type === "done" && entry.data?.data?.points)?.data.data);
  const fields = (page) => page.evaluate(() => Object.fromEntries(
    ["measure-start", "measure-end", "trim-start", "trim-end", "sync-offset", "stretch-percent"].map((id) => [id, document.getElementById(id).value])));
  const events = async (page, start, end) => {
    closeTo(Number(await page.locator("#measure-start").inputValue()), start, "Selected ignition marker");
    closeTo(Number(await page.locator("#measure-end").inputValue()), end, "Selected burnout marker");
  };
  const uploadVideo = async (page) => {
    if (!videoFixture) videoFixture = Buffer.from(await page.evaluate(async () => {
      const { Output, BufferTarget, Mp4OutputFormat, CanvasSource } = await import(`${location.origin}/__qa__/custom-csv-media.mjs`);
      const canvas = new OffscreenCanvas(320, 180), context = canvas.getContext("2d");
      const target = new BufferTarget(), output = new Output({ target, format: new Mp4OutputFormat() });
      const source = new CanvasSource(canvas, { codec: "avc", bitrate: 200000 });
      output.addVideoTrack(source, { frameRate: 10 }); await output.start();
      for (let index = 0; index < 50; index++) {
        context.fillStyle = "#c7d3d8"; context.fillRect(0, 0, 320, 180);
        context.fillStyle = "#334b49"; context.fillRect(148, 65, 24, 115);
        await source.add(index / 10, .1);
      }
      source.close(); await output.finalize(); return Array.from(new Uint8Array(target.buffer));
    }));
    await page.locator("#video-input").setInputFiles({ name: "PRIVATE-CUSTOM-VIDEO.mp4", mimeType: "video/mp4", buffer: videoFixture });
    await page.waitForFunction(() => document.querySelector("#timing-video-detail").textContent.includes("50 frames checked") &&
      document.querySelector("#source-video").readyState >= 2); await frame(page);
  };
  const seek = async (page, time) => {
    await page.locator("#scrubber").evaluate((input, value) => {
      input.value = String(value); input.dispatchEvent(new Event("input", { bubbles: true }));
    }, time);
    await page.waitForFunction((time) => !document.querySelector("#source-video").seeking &&
      Math.abs(document.querySelector("#source-video").currentTime - time) < .002, time); await frame(page);
  };
  const caseOf = async (name, run) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: "en-US" });
    page.on("pageerror", (error) => failures.push(`Custom CSV: ${error.message}`));
    page.on("console", (entry) => { if (entry.type() === "error") failures.push(`Custom CSV: ${entry.text()}`); });
    page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
    await page.route("**/__qa__/custom-csv-media.mjs", (route) => route.fulfill({ contentType: "text/javascript", body: mediaModule }));
    await page.addInitScript(() => {
      window.__customWorkerMessages = []; window.__customWorkerJobs = []; window.__customDrawing = [];
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...arguments_) {
          super(...arguments_);
          this.addEventListener("message", ({ data }) => {
            if (data?.data?.points || data?.result?.data?.points || data?.result?.records)
              window.__customWorkerMessages.push({ data });
          });
        }
        postMessage(job, ...arguments_) {
          window.__customWorkerJobs.push({
            name: job.file?.name, settings: job.settings, type: job.type,
            entries: job.entries?.map(({ id, file, settings }) => ({ id, name: file?.name, settings })),
            format: job.format, start: job.start, end: job.end,
            pressure: job.format ? job.data?.pressurePoints?.map(({ t, pressure }) => ({ t, pressure })) : undefined,
          });
          return super.postMessage(job, ...arguments_);
        }
      };
      const fillRect = CanvasRenderingContext2D.prototype.fillRect, fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
        if (this.canvas.id === "preview" && x === 0 && y === 0 && width === this.canvas.width && height === this.canvas.height)
          window.__customDrawing = [];
        return fillRect.call(this, x, y, width, height);
      };
      CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...arguments_) {
        if (this.canvas.id === "preview") {
          const point = new DOMPoint(x, y).matrixTransform(this.getTransform());
          window.__customDrawing.push({ text: String(text), x: point.x, y: point.y });
        }
        return fillText.call(this, text, x, y, ...arguments_);
      };
    });
    try {
      await page.goto(baseURL); await page.locator("#language-select").selectOption("en"); await frame(page);
      await run(page); console.log(`PASS: ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error.stack || error.message || String(error)}`);
      await page.screenshot({ path: join(outputDir, `custom-csv-failure-${failures.length}.png`), fullPage: true }).catch(() => {});
    } finally { await page.close(); }
  };

  await caseOf("standard logs import directly while unknown columns open a numbered local preview", async (page) => {
    await page.locator("#csv-input").setInputFiles(standard());
    await page.waitForFunction(() => document.querySelector("#csv-filename").textContent === "PRIVATE-STANDARD.csv");
    assert.equal(await page.locator("#csv-mapping-dialog").isVisible(), false);
    const data = await lastData(page);
    closeTo(data.points[1].thrust, 98.0665, "Standard import keeps kilogram-force defaults");
    await page.locator("#csv-input").setInputFiles(custom());
    await page.locator("#csv-mapping-dialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#csv-map-filename").textContent(), "PRIVATE-CUSTOM-LOG.csv");
    assert.equal(await page.locator("#csv-map-preview-body tr").count(), 5);
    assert.match(await page.locator("#csv-map-preview-head").textContent(), /1 · clock_force/);
    assert.equal(await page.locator("#csv-map-preview-body tr").first().locator("th").textContent(), "2", "Preview rows identify physical source lines");
    await page.screenshot({ path: join(outputDir, "custom-csv-desktop-column-editor.png"), fullPage: false });
    await page.locator("#csv-map-apply").click();
    assert.equal(await page.locator("#csv-map-error").isVisible(), true, "An unknown clock must require an explicit time unit");
    await mapped(page, { pressureTime: "" });
    await events(page, 1, 3);
    assert.equal((await lastData(page)).separateTime, false, "One selected clock can serve both channels");
  });

  await caseOf("independent millisecond and microsecond clocks retain pressure spikes, physical rows, and explicit event flags", async (page) => {
    await uploadVideo(page); await upload(page, custom("PRIVATE-INDEPENDENT.csv", { events: true }), { mode: "events" });
    await events(page, 1, 3);
    const data = await lastData(page);
    assert.deepEqual(data.points.map(({ t }) => t), [0, 1, 2, 3, 4]);
    assert.equal(data.pressurePoints.length, 5);
    [0, 1.4, 1.5, 1.6, 4].forEach((time, index) => closeTo(data.pressurePoints[index].t, time, "Native microsecond pressure time", 1e-12));
    assert.equal(data.peakPressure, 90, "A pressure spike between thrust samples must survive import");
    assert.equal(data.pressurePoints[2].line, 4);
    assert.equal(data.separateTime, true);
    assert.deepEqual(data.events, { start: 1, end: 3, periods: 1, source: "columns" });
    await page.locator("#tab-overlay").click(); await select(page, "presentation-layout", "stacked");
    for (const [time, value, pressureRow] of [[1.4, "0.0 bar", 3], [1.5, "90.0 bar", 4], [1.6, "0.0 bar", 5]]) {
      await seek(page, time);
      const drawing = await page.evaluate(() => window.__customDrawing);
      const label = drawing.find(({ text }) => text === "Pressure · bar");
      assert.ok(label, "The independent pressure channel needs a visible chart label");
      assert.ok(drawing.some(({ text, y }) => text === value && Math.abs(y - label.y) < 1), `The current pressure at ${time}s must be ${value}`);
      assert.equal(await page.locator("#video-log-row").textContent(), `T 3 → 4 · P ${pressureRow}`, "Each source row follows its own native channel clock");
    }
    await page.screenshot({ path: join(outputDir, "custom-csv-independent-channels.png"), fullPage: false });
  });

  await caseOf("pressure remains live outside the thrust range and a pressure-only trim exports the native pressure clock", async (page) => {
    await uploadVideo(page);
    const rows = [0, 1, 2, 3, 4].map((index) => [
      (2 + index / 2) * 1000, [0, 10, 10, 0, 0][index],
      [0, .5, 1, 2.5, 4.8][index] * 1000000, [0, 90, 90, 90, 90][index],
      [0, 1, 1, 0, 0][index], [0, 1, 0, 0, 0][index], [0, 0, 0, 1, 0][index], 0, (7 + index / 2) * 1000,
    ].join(";"));
    await upload(page, file("PRIVATE-PRESSURE-ONLY-RANGE.csv", [headers, ...rows].join("\n")));
    await page.locator("#tab-overlay").click(); await select(page, "presentation-layout", "stacked");
    for (const time of [.5, 4.5]) {
      await seek(page, time);
      const drawing = await page.evaluate(() => window.__customDrawing);
      const pressure = drawing.find(({ text }) => text === "Pressure · bar");
      assert.ok(drawing.some(({ text, y }) => text === "90.0 bar" && Math.abs(y - pressure.y) < 1), `Pressure at ${time}s remains available outside thrust samples`);
      assert.ok(drawing.some(({ text }) => text === "ACTIVE"), `Pressure-only samples at ${time}s must be live`);
      assert.ok(!drawing.some(({ text }) => /AWAITING DATA|TEST COMPLETE/.test(text)), "Valid pressure samples must not be labeled awaiting or complete");
    }
    await page.locator("#tool-timeline").click(); await change(page, "trim-start", 4.2); await change(page, "trim-end", 4.8);
    await page.locator("#tab-export").click();
    assert.equal(await page.locator("#export-button").isEnabled(), true, "Save must stay available when only pressure overlaps the selected video range");
    const downloadPromise = page.waitForEvent("download", { timeout: 60000 }); await page.locator("#export-button").click();
    const download = await downloadPromise;
    const encoded = await readFile(await download.path()); assert.ok(encoded.length > 1000, "A pressure-only interval must produce an actual video");
    const job = await page.evaluate(() => [...window.__customWorkerJobs].reverse().find(({ format }) => format === "mp4"));
    closeTo(job.start, 4.2, "Pressure-only export start"); closeTo(job.end, 4.8, "Pressure-only export end");
    assert.equal(job.pressure.length, 5); closeTo(job.pressure.at(-1).t, 4.8, "Export keeps native pressure times", 1e-12);
    assert.equal(job.pressure[1].pressure, 90); await download.delete();
  });

  await caseOf("headerless, sparse, and thrust-only logs preserve physical lines and do not invent missing pressure", async (page) => {
    await upload(page, custom("PRIVATE-HEADERLESS.csv", { header: false }), { header: false, pressure: "" });
    await events(page, 1, 3);
    let data = await lastData(page);
    assert.equal(data.hasHeader, false); assert.equal(data.points[0].line, 1);
    assert.deepEqual(data.pressurePoints, []); assert.equal(data.peakPressure, null);
    await page.locator("#csv-input").setInputFiles(file("PRIVATE-SPARSE.csv", [headers,
      "0;0;0;0;0;0;0;0;5000", "500;;500000;20;0;0;0;0;5500", "1000;10;1000000;;1;1;0;0;6000",
      "1500;;1500000;40;1;0;0;0;6500", "2000;0;2000000;0;0;0;1;0;7000"].join("\n")));
    await page.locator("#csv-mapping-dialog").waitFor({ state: "visible" });
    await page.locator("#csv-map-sparse").setChecked(true); await mapped(page);
    data = await lastData(page);
    assert.deepEqual(data.points.map(({ t, line }) => [t, line]), [[0, 2], [1, 4], [2, 6]]);
    assert.deepEqual(data.pressurePoints.map(({ t, line }) => [t, line]), [[0, 2], [.5, 3], [1.5, 5], [2, 6]]);
    await events(page, 1, 2);
  });

  await caseOf("a recognized generic time column prompts for its unknown unit rather than rejecting the log", async (page) => {
    await page.locator("#csv-input").setInputFiles(file("PRIVATE-GENERIC-CLOCK.csv", "time;thrust;pressure\n0;0;0\n1000;10;2\n2000;10;2\n3000;0;0"));
    await page.locator("#csv-mapping-dialog").waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await page.locator("#csv-map-thrust-time").inputValue(), "0");
    assert.equal(await page.locator("#csv-map-thrust").inputValue(), "1");
    await select(page, "csv-map-time-unit", "ms"); await page.locator("#csv-map-apply").click(); await settle(page);
    assert.equal(await page.locator("#csv-filename").textContent(), "PRIVATE-GENERIC-CLOCK.csv");
    assert.deepEqual((await lastData(page)).points.map(({ t }) => t), [0, 1, 2, 3]);
  });

  await caseOf("canceling a replacement preserves the valid source and timing while pressure-only remapping keeps manual events", async (page) => {
    await uploadVideo(page); await upload(page, custom());
    await page.locator("#tool-measurement").click();
    await change(page, "measure-start", .8); await change(page, "measure-end", 2.8);
    await page.locator("#tool-timeline").click();
    for (const [id, value] of [["trim-start", .2], ["trim-end", 3.4], ["sync-offset", .15], ["stretch-percent", 125]]) await change(page, id, value);
    const before = await fields(page), source = await lastData(page);
    await page.locator("#csv-input").setInputFiles(custom("PRIVATE-CANCELED.csv", { offset: 20 }));
    await page.locator("#csv-mapping-dialog").waitFor({ state: "visible" }); await page.locator("#csv-map-cancel").click(); await settle(page);
    assert.equal(await page.locator("#csv-filename").textContent(), "PRIVATE-CUSTOM-LOG.csv");
    assert.deepEqual(await fields(page), before); assert.deepEqual(await lastData(page), source);
    await page.locator("#tab-sources").click(); await reveal(page.locator("#csv-columns")); await page.locator("#csv-columns").click();
    await mapped(page, { pressure: "7" });
    assert.deepEqual(await fields(page), before, "Changing only the pressure column must preserve A/B, trim, offset, and duration");
    assert.equal((await lastData(page)).peakPressure, 4);
    await page.locator("#csv-columns").click(); await mapped(page, { pressure: "7", thrustTime: "8" });
    await events(page, 6, 8);
    closeTo(Number(await page.locator("#sync-offset").inputValue()), 0, "Changing the thrust clock resets synchronization");
    closeTo(Number(await page.locator("#stretch-percent").inputValue()), 100, "Changing the thrust clock resets duration scaling");
  });

  await caseOf("theoretical profiles use the same custom clocks, event columns, and cancellable column editor", async (page) => {
    await page.locator("#theory-input").setInputFiles(custom("PRIVATE-CUSTOM-THEORY.csv", { offset: 10, events: true }));
    await mapped(page, { mode: "events" });
    assert.equal(await page.locator("#theory-name").textContent(), "PRIVATE-CUSTOM-THEORY.csv");
    closeTo(Number(await page.locator("#theory-start").inputValue()), 11, "Theory ignition uses selected start flags");
    closeTo(Number(await page.locator("#theory-end").inputValue()), 13, "Theory burnout uses selected end flags");
    const data = await page.evaluate(() => [...window.__customWorkerMessages].reverse().find(({ data }) => data.result?.data?.points)?.data.result.data);
    assert.equal(data.peakPressure, 90); assert.equal(data.sourceUnits.pressureTime, "us");
    await reveal(page.locator("#theory-offset")); await change(page, "theory-offset", .75); await change(page, "theory-scale", 125);
    await page.locator("#theory-columns").click(); await page.locator("#csv-mapping-dialog").waitFor({ state: "visible" });
    await select(page, "csv-map-pressure", "7"); await page.keyboard.press("Escape"); await settle(page);
    closeTo(Number(await page.locator("#theory-offset").inputValue()), .75, "Cancel keeps theory calibration");
    closeTo(Number(await page.locator("#theory-scale").inputValue()), 125, "Cancel keeps theory duration");
    await page.locator("#theory-columns").click(); await mapped(page, { mode: "events", pressure: "7" });
    closeTo(Number(await page.locator("#theory-start").inputValue()), 11, "Pressure-only theory remapping keeps ignition");
    closeTo(Number(await page.locator("#theory-offset").inputValue()), .75, "Pressure-only theory remapping keeps calibration");
  });

  await caseOf("one batch column setup compares files with independent events and allows individual remapping", async (page) => {
    await page.locator("#mode-analysis").click();
    await page.locator("#profiles-input").setInputFiles([custom("PRIVATE-BATCH-A.csv", { events: true }), custom("PRIVATE-BATCH-B.csv", { offset: 10, events: true })]);
    await mapped(page, { mode: "events" });
    await page.waitForFunction(() => document.querySelectorAll("#profiles-list [data-profile-id]").length === 2 &&
      document.querySelector("#profile-analysis").getAttribute("aria-busy") !== "true");
    assert.equal(await page.locator("#csv-mapping-dialog").isVisible(), false, "Matching batch schemas need only one setup");
    const cards = page.locator("#profiles-list [data-profile-id]");
    const ids = [];
    for (let index = 0; index < 2; index++) {
      const card = cards.nth(index), id = await card.getAttribute("data-profile-id"); ids.push(id);
      closeTo(Number(await card.locator('[data-field="start"]').inputValue()), 1 + index * 10, "Each file keeps its own ignition");
      closeTo(Number(await card.locator('[data-field="end"]').inputValue()), 3 + index * 10, "Each file keeps its own burnout");
      const row = page.locator(`#profiles-table tr[data-profile-id="${id}"]`);
      closeTo(Number(await row.locator('[data-stat="duration"]').getAttribute("data-value")), 2, "Batch burn duration");
      closeTo(Number(await row.locator('[data-stat="peakPressure"]').getAttribute("data-value")), 90, "Native pressure peak in profile analysis");
    }
    const first = cards.first();
    await first.locator('[data-field="start"]').fill("1.1"); await first.locator('[data-field="start"]').press("Tab"); await settle(page);
    await first.locator('[data-action="columns"]').click(); await mapped(page, { mode: "events", pressure: "7" });
    closeTo(Number(await first.locator('[data-field="start"]').inputValue()), 1.1, "Individual pressure remap preserves custom A");
    closeTo(Number(await page.locator(`#profiles-table tr[data-profile-id="${ids[0]}"] [data-stat="peakPressure"]`).getAttribute("data-value")), 4, "Only the remapped pressure column changes");
    closeTo(Number(await page.locator(`#profiles-table tr[data-profile-id="${ids[1]}"] [data-stat="peakPressure"]`).getAttribute("data-value")), 90, "The other profile keeps its native pressure");
    const downloadPromise = page.waitForEvent("download"); await page.locator("#profiles-export").click();
    const download = await downloadPromise; const csv = await readFile(await download.path(), "utf8");
    assert.match(csv, /PRIVATE-BATCH-A\.csv/); assert.match(csv, /PRIVATE-BATCH-B\.csv/);
    const csvRows = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map((line) => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((cell) => cell.replace(/^"|"$/g, "").replaceAll('""', '"')));
    const reportHeaders = csvRows.shift();
    const reports = csvRows.map((cells) => Object.fromEntries(reportHeaders.map((key, index) => [key, cells[index]])));
    for (let index = 0; index < reports.length; index++) {
      const report = reports[index];
      assert.equal(report.source_thrust_time_column, "1"); assert.equal(report.source_thrust_column, "2");
      assert.equal(report.source_pressure_time_column, "3"); assert.equal(report.source_pressure_column, index === 0 ? "8" : "4");
      assert.equal(report.source_marker_mode, "events"); assert.equal(report.source_ignition_column, "6"); assert.equal(report.source_burnout_column, "7");
      assert.equal(report.source_pressure_time_unit, "us");
    }
    await download.delete();
    await select(page, "profiles-mode", "series");
    assert.equal(Number(await page.locator('#series-summary [data-series-stat="impulse"] [data-series-value="n"]').getAttribute("data-value")), 2);
    await page.screenshot({ path: join(outputDir, "custom-csv-batch-analysis.png"), fullPage: false });
  });

  await caseOf("file schemas and column indices stay out of browser preferences and do not silently map a later file", async (page) => {
    await upload(page, custom());
    await page.locator("#meta-motor").fill("REUSABLE MODEL"); await page.locator("#meta-motor").press("Tab");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("flamesync.preferences"))?.values?.["meta-motor"] === "REUSABLE MODEL");
    const saved = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
    for (const token of ["PRIVATE-CUSTOM", "clock_force", "clock_pressure", "thrustTime", "pressureTime", "markerMode", "hasHeader", "allowSparse", "csv-map-"])
      assert.ok(!saved.includes(token), `${token} must remain file-specific`);
    await page.reload(); await frame(page);
    assert.equal(await page.locator("#meta-motor").inputValue(), "REUSABLE MODEL");
    assert.equal(await page.locator("#csv-input").evaluate((input) => input.files.length), 0);
    await page.locator("#csv-input").setInputFiles(custom("PRIVATE-AFTER-RELOAD.csv"));
    await page.locator("#csv-mapping-dialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#csv-map-marker-mode").inputValue(), "none", "A different file needs an explicit event mapping");
    await page.locator("#csv-map-cancel").click();
  });

  await caseOf("English and Ukrainian column editors fit a narrow screen with readable selectors and accessible cancellation", async (page) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const language of ["en", "uk"]) {
      await page.locator("#language-select").selectOption(language);
      await page.locator("#csv-input").setInputFiles(custom(`PRIVATE-MOBILE-${language}.csv`));
      const dialog = page.locator("#csv-mapping-dialog"); await dialog.waitFor({ state: "visible" });
      const geometry = await dialog.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const controls = [...node.querySelectorAll("select, button")].filter((input) => input.getClientRects().length).map((input) => {
          const box = input.getBoundingClientRect(); return { id: input.id, x: box.x, y: box.y, width: box.width, height: box.height };
        });
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight,
          scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, controls };
      });
      assert.ok(geometry.x >= -1 && geometry.y >= -1 && geometry.right <= geometry.width + 1 && geometry.bottom <= geometry.height + 1,
        `${language} dialog must stay inside the viewport: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, `${language} dialog should scroll its preview without horizontal page overflow`);
      for (const control of geometry.controls) assert.ok(control.width >= 25 && control.height >= 25, `${control.id} must remain usable`);
      for (const id of ["csv-map-apply", "csv-map-cancel"]) {
        const action = geometry.controls.find((control) => control.id === id);
        assert.ok(action && action.y >= 0 && action.y + action.height <= geometry.height + 1,
          `${language} ${id} must remain visible without scrolling the column editor`);
      }
      for (let index = 0; index < geometry.controls.length; index++) for (const other of geometry.controls.slice(index + 1)) {
        const first = geometry.controls[index];
        const overlapX = Math.min(first.x + first.width, other.x + other.width) - Math.max(first.x, other.x);
        const overlapY = Math.min(first.y + first.height, other.y + other.height) - Math.max(first.y, other.y);
        assert.ok(overlapX <= 1 || overlapY <= 1, `${language} controls overlap: ${first.id}, ${other.id}`);
      }
      assert.equal(await page.locator("#csv-map-title").textContent(), language === "uk" ? "Стовпчики CSV" : "CSV columns");
      await page.screenshot({ path: join(outputDir, `custom-csv-mobile-${language}.png`), fullPage: false });
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" }); await settle(page);
      assert.equal(await page.locator("#clear-settings").isEnabled(), true, "Cancel must restore the workspace controls");
    }
  });
  return { failures, requests };
}
