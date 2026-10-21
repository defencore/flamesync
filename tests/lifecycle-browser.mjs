import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Input, BufferSource, EncodedPacketSink, ALL_FORMATS } from "mediabunny";

const csv = (name) => ({ name, mimeType: "text/csv", buffer: Buffer.from(
  "time_ms;thrust;pressure\n0;0;0\n500;10;2\n1000;10;2\n1500;10;2\n2000;10;2\n2500;0;0") });
const projectFields = ["measure-start", "measure-end", "trim-start", "trim-end", "sync-offset", "stretch-percent", "theory-start", "theory-end", "theory-offset", "theory-scale"];

/** Verify public editor behavior across cached page suspension and restoration. */
export async function verifyLifecycle({ browser, baseURL, outputDir }) {
  const failures = [], requests = [];
  const mediaModule = await readFile(new URL("../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs", import.meta.url), "utf8");
  let videoFixture;
  const frame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const settle = async (page) => {
    await frame(page);
    await page.waitForFunction(() => !document.querySelector("#clear-settings").disabled);
    await frame(page);
  };
  const reveal = (input) => input.locator("xpath=ancestor::details").evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
  const change = async (page, id, value) => {
    const input = page.locator(`#${id}`); await reveal(input);
    await input.fill(String(value)); await input.press("Tab"); await frame(page);
  };
  const seek = async (page, time) => {
    await page.locator("#scrubber").evaluate((input, time) => {
      input.value = String(time); input.dispatchEvent(new Event("input", { bubbles: true }));
    }, time);
    await page.waitForFunction((time) => !document.querySelector("#source-video").seeking &&
      Math.abs(document.querySelector("#source-video").currentTime - time) < .002, time);
    await frame(page);
  };
  const snapshot = (page) => page.evaluate((ids) => ({
    videoName: document.querySelector("#video-filename").textContent,
    logName: document.querySelector("#csv-filename").textContent,
    theoryName: document.querySelector("#theory-name").textContent,
    src: document.querySelector("#source-video").src,
    fields: Object.fromEntries(ids.map((id) => [id, document.getElementById(id).value])),
    profiles: [...document.querySelectorAll("#profiles-list [data-profile-id]")].map((card) => ({
      id: card.dataset.profileId, name: card.querySelector(".profile-name").textContent,
      start: card.querySelector('[data-field="start"]').value, end: card.querySelector('[data-field="end"]').value,
    })),
  }), projectFields);
  const prepare = async (page) => {
    await page.locator("#language-select").selectOption("en");
    if (!videoFixture) {
      await page.route("**/__qa__/lifecycle-media.mjs", (route) => route.fulfill({ contentType: "text/javascript", body: mediaModule }));
      videoFixture = Buffer.from(await page.evaluate(async () => {
        const { Output, BufferTarget, Mp4OutputFormat, CanvasSource } = await import(`${location.origin}/__qa__/lifecycle-media.mjs`);
        const canvas = new OffscreenCanvas(320, 180), context = canvas.getContext("2d");
        const target = new BufferTarget(), output = new Output({ target, format: new Mp4OutputFormat() });
        const source = new CanvasSource(canvas, { codec: "avc", bitrate: 200000 });
        output.addVideoTrack(source, { frameRate: 10 }); await output.start();
        for (let index = 0; index < 30; index++) {
          context.fillStyle = "#c8d5d7"; context.fillRect(0, 0, 320, 180);
          context.fillStyle = "#334f49"; context.fillRect(148, 65, 24, 115);
          await source.add(index / 10, .1);
        }
        source.close(); await output.finalize(); return Array.from(new Uint8Array(target.buffer));
      }));
    }
    await page.locator("#video-input").setInputFiles({ name: "PRIVATE-LIFECYCLE-VIDEO.mp4", mimeType: "video/mp4", buffer: videoFixture });
    await page.waitForFunction(() => document.querySelector("#timing-video-detail").textContent.includes("30 frames checked") &&
      document.querySelector("#source-video").readyState >= 2);
    await page.locator("#csv-input").setInputFiles(csv("PRIVATE-LIFECYCLE-LOG.csv"));
    await page.waitForFunction(() => document.querySelector("#csv-filename").textContent === "PRIVATE-LIFECYCLE-LOG.csv" &&
      !document.querySelector("#clear-settings").disabled);
    await page.locator("#theory-input").setInputFiles(csv("PRIVATE-LIFECYCLE-THEORY.csv"));
    await page.waitForFunction(() => document.querySelector("#theory-name").textContent === "PRIVATE-LIFECYCLE-THEORY.csv" &&
      document.querySelector("#theory-panel").getAttribute("aria-busy") !== "true");
    await change(page, "theory-start", .5); await change(page, "theory-end", 2);
    await change(page, "theory-offset", .1);
    await page.locator("#mode-analysis").click();
    await page.locator("#profiles-input").setInputFiles(csv("PRIVATE-LIFECYCLE-PROFILE.csv"));
    await page.waitForFunction(() => document.querySelectorAll("#profiles-list [data-profile-id]").length === 1 &&
      document.querySelector("#profile-analysis").getAttribute("aria-busy") !== "true");
    await page.locator("#mode-video").click();
    await page.locator("#tool-measurement").click();
    await change(page, "measure-start", .5); await change(page, "measure-end", 2);
    await page.locator("#tool-timeline").click();
    await change(page, "trim-start", .2); await change(page, "trim-end", 2.4);
    await change(page, "sync-offset", .125);
    await settle(page); await seek(page, 1);
    return snapshot(page);
  };
  const assertPreserved = async (page, before) => {
    assert.deepEqual(await snapshot(page), before, "Cached restoration must preserve source URLs, files, A/B, trim, synchronization, theory, and profile records");
    assert.equal(await page.locator("#source-video").evaluate((video) => video.paused), true, "A cached page must resume paused");
    assert.equal(await page.evaluate((src) => window.__lifecycleRevoked.includes(src), before.src), false, "Cached suspension must not revoke the source video URL");
    assert.equal(await page.locator("#export-button").isEnabled(), true, "A preserved project must remain exportable");
  };
  const verifyEditing = async (page) => {
    await seek(page, 1); await page.locator("#frame-next").click();
    await page.waitForFunction(() => !document.querySelector("#source-video").seeking &&
      Math.abs(document.querySelector("#source-video").currentTime - 1.1) < .002);
    await page.locator("#tab-sources").click();
    const thrust = page.locator("#source-thrust-unit"); await reveal(thrust);
    await thrust.selectOption("N");
    await page.waitForFunction(() => document.querySelector("#summary-thrust").textContent === "1.02 kgf" &&
      !document.querySelector("#clear-settings").disabled);
    await thrust.selectOption("kgf");
    await page.waitForFunction(() => document.querySelector("#summary-thrust").textContent === "10.0 kgf" &&
      !document.querySelector("#clear-settings").disabled);
    await page.locator("#meta-motor").fill("PREFERENCES STILL ACTIVE");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("flamesync.preferences"))?.values?.["meta-motor"] === "PREFERENCES STILL ACTIVE");
    await change(page, "theory-offset", .2);
    assert.equal(Number(await page.locator("#theory-offset").inputValue()), .2);
    await page.locator("#mode-analysis").click();
    const card = page.locator("#profiles-list [data-profile-id]").first();
    await card.locator('[data-field="start"]').fill("0.6"); await card.locator('[data-field="start"]').press("Tab"); await settle(page);
    assert.equal(Number(await card.locator('[data-field="start"]').inputValue()), .6);
    const id = await card.getAttribute("data-profile-id");
    assert.ok(Number(await page.locator(`#profiles-table tr[data-profile-id="${id}"] [data-stat="impulse"]`).getAttribute("data-value")) > 0,
      "Restored analysis workers must recompute real statistics");
    await page.locator("#mode-video").click(); await page.locator("#tool-measurement").click();
    await change(page, "measure-start", .6);
    assert.equal(Number(await page.locator("#measure-start").inputValue()), .6);
    await page.locator("#tool-timeline").click(); await change(page, "sync-offset", .25);
    assert.equal(Number(await page.locator("#sync-offset").inputValue()), .25);
  };
  const caseOf = async (name, run) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: "en-US" });
    page.on("pageerror", (error) => failures.push(`Page lifecycle: ${error.message}`));
    page.on("console", (entry) => { if (entry.type() === "error") failures.push(`Page lifecycle: ${entry.text()}`); });
    page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
    await page.addInitScript(() => {
      window.__lifecycleDocument = crypto.randomUUID();
      window.__lifecycleEvents = []; window.__lifecycleRevoked = []; window.__lifecycleExportJobs = [];
      for (const type of ["pagehide", "pageshow"]) window.addEventListener(type, (event) => window.__lifecycleEvents.push({ type, persisted: event.persisted }));
      const revoke = URL.revokeObjectURL;
      URL.revokeObjectURL = function (url) { window.__lifecycleRevoked.push(url); return revoke.call(this, url); };
      const postMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (job, ...arguments_) {
        if (job?.file && ["mp4", "webm"].includes(job.format)) window.__lifecycleExportJobs.push({
          frameCount: job.sourceInfo?.timestamps?.length, fps: job.sourceInfo?.fps,
          start: job.start, end: job.end, format: job.format,
        });
        return postMessage.call(this, job, ...arguments_);
      };
    });
    try {
      await page.goto(baseURL); await frame(page); await run(page); console.log(`PASS: ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error.stack || error.message || String(error)}`);
      await page.screenshot({ path: join(outputDir, `lifecycle-failure-${failures.length}.png`), fullPage: true }).catch(() => {});
    } finally { await page.close(); }
  };

  await caseOf("persisted pagehide flushes pending preferences and pauses without disposing imported sources, analysis, or export", async (page) => {
    const before = await prepare(page);
    await page.locator("#play-button").click();
    await page.waitForFunction(() => !document.querySelector("#source-video").paused);
    const flushed = await page.evaluate(() => {
      const input = document.querySelector("#meta-motor");
      input.value = "CACHE DRAFT FLUSHED ON HIDE"; input.dispatchEvent(new Event("input", { bubbles: true }));
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      return JSON.parse(localStorage.getItem("flamesync.preferences"))?.values?.["meta-motor"];
    });
    assert.equal(flushed, "CACHE DRAFT FLUSHED ON HIDE", "Suspension must flush immediately rather than waiting for a debounce timer");
    assert.equal(await page.locator("#source-video").evaluate((video) => video.paused), true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await settle(page); await assertPreserved(page, before); await verifyEditing(page);
    await page.locator("#tab-export").click();
    const downloading = page.waitForEvent("download", { timeout: 60000 }); await page.locator("#export-button").click();
    const download = await downloading;
    const encoded = await readFile(await download.path());
    const output = new Input({ source: new BufferSource(encoded), formats: ALL_FORMATS });
    try {
      const track = await output.getPrimaryVideoTrack();
      assert.equal(track.codec, "avc"); assert.equal(track.displayWidth, 1920); assert.equal(track.displayHeight, 1080);
      assert.ok(Math.abs(await output.computeDuration() - 2.2) < .02, "The restored exporter must preserve the selected duration");
    } finally { output.dispose(); await download.delete(); }
    await page.screenshot({ path: join(outputDir, "lifecycle-restored-editor.png"), fullPage: false });
  });

  await caseOf("browser history restoration preserves the exact editor document when Chrome accepts the page into BFCache", async (page) => {
    const before = await prepare(page), documentId = await page.evaluate(() => window.__lifecycleDocument);
    await page.locator("#meta-motor").fill("ACTUAL HISTORY CACHE DRAFT");
    const away = new URL(baseURL); away.searchParams.set("lifecycle", "away");
    await page.goto(away.href); await frame(page);
    await page.goBack({ waitUntil: "commit" });
    await page.locator("#language-select").waitFor(); await frame(page);
    const observation = await page.evaluate(() => ({ id: window.__lifecycleDocument, events: window.__lifecycleEvents,
      reasons: performance.getEntriesByType("navigation")[0]?.notRestoredReasons?.toJSON?.() ?? null }));
    if (observation.id !== documentId) {
      // Cache eligibility is controlled by the browser. The persisted-event
      // integration above remains mandatory when this environment reloads it.
      console.log(`INFO: Chrome history used a document reload; persisted lifecycle integration verified separately. Reasons: ${JSON.stringify(observation.reasons)}`);
      assert.equal(await page.locator("#meta-motor").inputValue(), "ACTUAL HISTORY CACHE DRAFT", "A real navigation must still flush reusable preferences");
      return;
    }
    assert.ok(observation.events.some(({ type, persisted }) => type === "pagehide" && persisted));
    assert.ok(observation.events.some(({ type, persisted }) => type === "pageshow" && persisted));
    await settle(page); await assertPreserved(page, before); await verifyEditing(page);
    assert.equal(await page.locator("#source-video").evaluate((video) => video.readyState >= 2), true);
    await page.screenshot({ path: join(outputDir, "lifecycle-real-history-cache.png"), fullPage: false });
    console.log("PASS: actual Chrome persisted pagehide/pageshow restored the same document, media URLs, workers, editing, and export readiness");
  });

  await caseOf("saving waits for native video frame indexing and exports the complete source frame table after inspection", async (page) => {
    await page.locator("#language-select").selectOption("en");
    let release, held, timeout;
    const gate = new Promise((resolve) => { release = resolve; });
    const intercepted = new Promise((resolve) => { held = resolve; });
    const workerRoute = async (route) => { held(); await gate; await route.continue(); };
    await page.route("**/*video-timing-worker*.js", workerRoute);
    try {
      await page.locator("#video-input").setInputFiles({ name: "PRIVATE-PENDING-FRAME-INDEX.mp4", mimeType: "video/mp4", buffer: videoFixture });
      await Promise.race([intercepted, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("The frame-index worker was not intercepted")), 5000); })]);
      clearTimeout(timeout);
      await page.locator("#csv-input").setInputFiles(csv("PRIVATE-INDEXED-LOG.csv"));
      await page.waitForFunction(() => document.querySelector("#csv-filename").textContent === "PRIVATE-INDEXED-LOG.csv" &&
        document.querySelector("#csv-drop").getAttribute("aria-busy") !== "true" && document.querySelector("#source-video").readyState >= 2);
      await frame(page);
      assert.equal(await page.locator("#timeline-undo").isDisabled(), true,
        "Automatic source and burn-anchor initialization must establish a clean edit-history baseline");
      assert.equal(await page.locator("[data-save-video]").evaluateAll((buttons) => buttons.length >= 2 && buttons.every((button) => button.disabled)), true,
        "Every Save action must wait even when both files and the video decoder are ready");
      assert.equal(await page.locator("#save-status").textContent(), "Reading your files…");
      assert.deepEqual(await page.evaluate(() => window.__lifecycleExportJobs), [], "A pending frame index cannot be snapshotted by an export job");
      release();
      await page.waitForFunction(() => document.querySelector("#timing-video-detail").textContent.includes("30 frames checked") &&
        !document.querySelector("#export-button").disabled);
      await frame(page);
      assert.equal((await page.locator("#video-frame-count").textContent()).trim(), "30");
      await page.locator("#tab-export").click();
      const downloading = page.waitForEvent("download", { timeout: 60000 }); await page.locator("#export-button").click();
      const download = await downloading;
      const encoded = await readFile(await download.path());
      const output = new Input({ source: new BufferSource(encoded), formats: ALL_FORMATS });
      try {
        const track = await output.getPrimaryVideoTrack(), times = [];
        for await (const packet of new EncodedPacketSink(track).packets()) times.push(packet.timestamp);
        assert.equal(track.codec, "avc"); assert.equal(track.displayWidth, 1920); assert.equal(track.displayHeight, 1080);
        assert.equal(times.length, 30, "The final output must preserve every native 10-fps source frame");
        assert.ok(Math.abs(Math.max(...times) - 2.9) < 1e-6);
        assert.ok(Math.abs(await output.computeDuration() - 3) < .02);
      } finally { output.dispose(); await download.delete(); }
      const jobs = await page.evaluate(() => window.__lifecycleExportJobs);
      assert.equal(jobs.length, 1); assert.equal(jobs[0].frameCount, 30); assert.equal(jobs[0].fps, 10);
      await page.screenshot({ path: join(outputDir, "lifecycle-indexed-export.png"), fullPage: false });
    } finally {
      clearTimeout(timeout); release(); await page.unroute("**/*video-timing-worker*.js", workerRoute);
    }
  });
  return { failures, requests };
}
