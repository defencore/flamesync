import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { Input, BufferSource, ALL_FORMATS } from "mediabunny";

// Logs are constructed in memory; no user files or fixture assets are uploaded.
function logFile(name, { offset = 0, rate = 50, unit = "ms", force = 10, pressure = 2 } = {}) {
  const multiplier = { ms: 1000, us: 1000000, s: 1 }[unit];
  const rows = [`time_${unit};thrust;pressure`];
  for (let index = 0; index <= rate * 4; index++) {
    const local = index / rate;
    const burning = local >= 1 && local <= 3;
    const time = unit === "s" ? (offset + local).toFixed(9) : Math.round((offset + local) * multiplier);
    rows.push(`${time};${burning ? force : 0};${burning ? pressure : 0}`);
  }
  return { name, mimeType: "text/csv", buffer: Buffer.from(rows.join("\n")) };
}

function closeTo(actual, expected, tolerance = 1e-6) {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance,
    `${actual} should equal ${expected} ± ${tolerance}`);
}

/** Exercise global theoretical CSV comparisons through public controls. */
export async function verifyTheory({ browser, baseURL, outputDir }) {
  const failures = [], requests = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: "en-US" });
  page.on("pageerror", (error) => failures.push(`Theoretical profile: ${error.message}`));
  page.on("console", (entry) => { if (entry.type() === "error") failures.push(`Theoretical profile: ${entry.text()}`); });
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  await page.addInitScript(() => {
    window.__theoryExportJobs = [];
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (job, ...arguments_) {
      if (job?.file && ["mp4", "webm"].includes(job.format))
        window.__theoryExportJobs.push({
          hasTheory: !!job.theory?.data?.points?.length, name: job.theory?.name,
          offset: job.theory?.offset, timeScale: job.theory?.timeScale,
          force: job.theory?.data?.points?.find((point) => point.thrust > 0)?.thrust,
          measurement: job.measurement,
        });
      return postMessage.call(this, job, ...arguments_);
    };
  });
  const cards = page.locator("#profiles-list [data-profile-id]");
  const rows = page.locator("#profiles-theory-results tbody tr[data-profile-id]");
  const ids = [];
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const settle = async () => {
    await frame();
    await page.waitForFunction(() =>
      document.querySelector("#profile-analysis").getAttribute("aria-busy") !== "true" &&
      document.querySelector("#theory-panel").getAttribute("aria-busy") !== "true");
    await frame();
  };
  const reveal = async (input) => {
    const ancestors = input.locator("xpath=ancestor::details");
    for (let index = 0; index < await ancestors.count(); index++) {
      const details = ancestors.nth(index);
      if (!await details.evaluate((element) => element.open)) await details.locator(":scope > summary").click();
    }
  };
  const change = async (id, value) => {
    const input = page.locator(`#${id}`);
    await reveal(input); await input.fill(String(value)); await input.press("Tab"); await settle();
  };
  const select = async (id, value) => {
    const input = page.locator(`#${id}`);
    await reveal(input); await input.selectOption(value); await settle();
  };
  const field = (id, name) => page.locator(`#profiles-list [data-profile-id="${id}"] [data-field="${name}"]`);
  const setField = async (id, name, value) => {
    const input = field(id, name);
    await reveal(input); await input.fill(String(value)); await input.press("Tab"); await settle();
  };
  const value = async (locator) => {
    const raw = await locator.getAttribute("data-value");
    return raw === "" || raw === null ? null : Number(raw);
  };
  const stat = (id, key) => value(page.locator(`#profiles-table tr[data-profile-id="${id}"] [data-stat="${key}"]`));
  const theoretical = (id, key) => value(page.locator(`#profiles-theory-results tr[data-profile-id="${id}"] [data-stat="${key}"]`));
  const seriesN = () => value(page.locator('#series-summary [data-series-stat="impulse"] [data-series-value="n"]'));
  const image = (id = "profiles-chart") => page.locator(`#${id}`).evaluate((canvas) => canvas.toDataURL());
  const setEnabled = async (enabled) => {
    const input = page.locator("#theory-enabled"); await reveal(input); await input.setChecked(enabled); await settle();
  };
  const theorySnapshot = () => page.evaluate(() => ({
    start: document.querySelector("#theory-start").value,
    end: document.querySelector("#theory-end").value,
    alignment: document.querySelector("#theory-alignment").value,
    offset: document.querySelector("#theory-offset").value,
    scale: document.querySelector("#theory-scale").value,
    enabled: document.querySelector("#theory-enabled").checked,
  }));
  const caseOf = async (name, run) => {
    try { await run(); console.log(`PASS: ${name}`); }
    catch (error) {
      failures.push(`${name}: ${error.stack || error.message || String(error)}`);
      await page.screenshot({ path: join(outputDir, `theory-failure-${failures.length}.png`), fullPage: true }).catch(() => {});
    }
  };

  try {
    await page.goto(baseURL);
    await page.locator("#language-select").selectOption("en");

    await caseOf("new video, analysis, and theoretical sources default to kgf and bar", async () => {
      for (const id of ["source-thrust-unit", "thrust-unit", "profiles-source-thrust", "profiles-thrust-unit", "theory-thrust-unit"])
        assert.equal(await page.locator(`#${id}`).inputValue(), "kgf", `${id} must default to kilogram-force`);
      for (const id of ["source-pressure-unit", "pressure-unit", "profiles-source-pressure", "profiles-pressure-unit", "theory-pressure-unit"])
        assert.equal(await page.locator(`#${id}`).inputValue(), "bar", `${id} must default to bar`);
      assert.equal(await page.locator("#theory-time-unit").inputValue(), "auto");
      assert.equal(await page.locator("#show-measurement").isChecked(), true, "Video burn boundaries should be enabled by default");
    });

    await page.locator("#mode-analysis").click();
    await caseOf("kgf measurements retain SI metrics while thrust and pressure are plotted separately", async () => {
      await page.locator("#profiles-input").setInputFiles([
        logFile("measured-01-50hz-ms.csv"),
        logFile("measured-02-120hz-us.csv", { offset: 20, rate: 120, unit: "us" }),
      ]);
      await settle();
      assert.equal(await cards.count(), 2);
      for (let index = 0; index < 2; index++) {
        const id = await cards.nth(index).getAttribute("data-profile-id");
        assert.ok(id); ids.push(id);
        assert.equal(await field(id, "thrustUnit").inputValue(), "kgf");
        assert.equal(await field(id, "pressureUnit").inputValue(), "bar");
        await setField(id, "start", 1 + index * 20); await setField(id, "end", 3 + index * 20);
        closeTo(await stat(id, "duration"), 2);
        closeTo(await stat(id, "meanThrust"), 98.0665);
        closeTo(await stat(id, "impulse"), 196.133);
        closeTo(await stat(id, "peakPressure"), 2);
        const display = await page.locator(`#profiles-table tr[data-profile-id="${id}"] [data-stat="meanThrust"]`).textContent();
        assert.match(display, /10[.,]000/, "The displayed force should remain 10 kgf");
      }
      for (const id of ["profiles-chart", "profiles-pressure-chart", "profiles-difference"])
        assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} must be a separate visible plot`);
      const dimensions = await page.locator("#profiles-pressure-chart").evaluate((canvas) => ({ width: canvas.clientWidth, height: canvas.clientHeight, backing: canvas.width }));
      assert.ok(dimensions.width > 250 && dimensions.height > 120 && dimensions.backing > 0);
    });

    await caseOf("one optional theory file compares independent clocks without joining the measured series", async () => {
      await page.locator("#theory-input").setInputFiles(logFile("theoretical-8kgf-1bar.csv", { offset: 10, rate: 80, unit: "us", force: 8, pressure: 1 }));
      await settle();
      await change("theory-start", 11); await change("theory-end", 13);
      await select("theory-alignment", "ignition"); await setEnabled(true);
      assert.equal(await cards.count(), 2, "Theory must not become a measured profile");
      assert.equal(await rows.count(), 2);
      for (const id of ids) {
        closeTo(await theoretical(id, "theoryImpulseChange"), 25);
        closeTo(await theoretical(id, "theoryDurationChange"), 0);
        closeTo(await theoretical(id, "theoryThrustRmse"), 19.6133);
        closeTo(await theoretical(id, "theoryPressureRmse"), 1);
      }
      await select("profiles-mode", "series");
      closeTo(await seriesN(), 2, 0);
      assert.equal(await rows.count(), 2);
      await select("profiles-mode", "comparison");
    });

    await caseOf("theoretical overlay toggles both plots and does not change measured physical statistics", async () => {
      const impulse = await stat(ids[0], "impulse");
      const onThrust = await image(), onPressure = await image("profiles-pressure-chart");
      await setEnabled(false);
      const offThrust = await image(), offPressure = await image("profiles-pressure-chart");
      assert.notEqual(offThrust, onThrust, "Thrust plot must contain the optional theoretical trace");
      assert.notEqual(offPressure, onPressure, "Pressure plot must contain the optional theoretical trace");
      assert.ok(await rows.count() === 0 || !(await rows.first().isVisible()), "A disabled reference must not retain active comparisons");
      closeTo(await stat(ids[0], "impulse"), impulse);
      await setEnabled(true);
      closeTo(await theoretical(ids[0], "theoryThrustRmse"), 19.6133);
    });

    await caseOf("theory event fitting and display units cannot rewrite source impulse or duration", async () => {
      const actualImpulse = await stat(ids[0], "impulse"), actualDuration = await stat(ids[0], "duration");
      for (const alignment of ["ignition", "burnout", "normalized"]) {
        await select("profiles-alignment", alignment);
        closeTo(await theoretical(ids[0], "theoryThrustRmse"), 19.6133);
        closeTo(await stat(ids[0], "impulse"), actualImpulse);
        closeTo(await stat(ids[0], "duration"), actualDuration);
      }
      await select("profiles-thrust-unit", "N"); await select("profiles-pressure-unit", "kPa");
      closeTo(await theoretical(ids[0], "theoryThrustRmse"), 19.6133);
      closeTo(await theoretical(ids[0], "theoryPressureRmse"), 1);
      closeTo(await stat(ids[0], "impulse"), actualImpulse);
      await select("profiles-thrust-unit", "kgf"); await select("profiles-pressure-unit", "bar");
      await select("profiles-alignment", "source");
      assert.equal(await theoretical(ids[0], "theoryThrustRmse"), null, "Disjoint source clocks must not create theoretical overlap");
      await select("profiles-alignment", "ignition");
    });

    await caseOf("theory comparison exports reproducible original-unit results locally", async () => {
      const event = page.waitForEvent("download");
      await page.locator("#profiles-theory-export").click();
      const download = await event;
      assert.match(download.suggestedFilename(), /\.csv$/i);
      const report = (await readFile(await download.path(), "utf8")).replace(/^\uFEFF/, "");
      const lines = report.trim().split(/\r?\n/);
      const headers = lines.shift().split(",");
      const cells = lines[0].split(",");
      const record = Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
      assert.equal(lines.length, 2, "Only measured tests should become report rows");
      assert.ok(report.includes("theoretical-8kgf-1bar.csv"));
      assert.ok(!/NaN|Infinity|undefined/.test(report));
      closeTo(Number(record.measured_impulse_Ns), 196.133);
      closeTo(Number(record.theory_impulse_Ns), 156.9064);
      closeTo(Number(record.impulse_difference_percent), 25);
      closeTo(Number(record.thrust_rmse_N), 19.6133);
      closeTo(Number(record.pressure_rmse_bar), 1);
    });

    await caseOf("a malformed theoretical replacement preserves the last valid reference", async () => {
      const baseline = await theorySnapshot();
      await page.locator("#theory-input").setInputFiles({ name: "invalid-theory.csv", mimeType: "text/csv", buffer: Buffer.from("time_ms;thrust;pressure\n0;1;1\n0;2;2") });
      await settle();
      assert.deepEqual(await theorySnapshot(), baseline);
      closeTo(await theoretical(ids[0], "theoryThrustRmse"), 19.6133);
      assert.equal(await cards.count(), 2);
      assert.match(await page.locator("#theory-panel").textContent(), /invalid-theory|timestamps must increase|last valid|could not|failed/i);
    });

    await caseOf("theoretical source units can be chosen independently from measured display units", async () => {
      await select("theory-thrust-unit", "N");
      closeTo(await theoretical(ids[0], "theoryThrustRmse"), 98.0665 - 8);
      closeTo(await stat(ids[0], "impulse"), 196.133);
      await select("theory-thrust-unit", "kgf");
      closeTo(await theoretical(ids[0], "theoryThrustRmse"), 19.6133);
      await select("theory-pressure-unit", "kPa");
      closeTo(await theoretical(ids[0], "theoryPressureRmse"), 1.99);
      await select("theory-pressure-unit", "bar");
      closeTo(await theoretical(ids[0], "theoryPressureRmse"), 1);
    });

    await caseOf("invalid video-only theoretical timing does not hide valid analysis comparisons", async () => {
      await change("theory-scale", 0);
      assert.equal(await page.locator("#theory-scale").getAttribute("aria-invalid"), "true");
      assert.equal(await page.locator("#profiles-theory-panel").isVisible(), true);
      closeTo(await theoretical(ids[0], "theoryThrustRmse"), 19.6133);
      await select("profiles-mode", "series"); closeTo(await seriesN(), 2, 0);
      closeTo(await theoretical(ids[1], "theoryPressureRmse"), 1);
      await select("profiles-mode", "comparison");
      await change("theory-scale", 100);
      assert.notEqual(await page.locator("#theory-scale").getAttribute("aria-invalid"), "true");
      closeTo(await theoretical(ids[0], "theoryThrustRmse"), 19.6133);
    });

    await caseOf("global theory and measured records survive locale and editor switches", async () => {
      const baseline = await theorySnapshot();
      await page.locator("#language-select").selectOption("uk"); await settle();
      assert.deepEqual(await theorySnapshot(), baseline);
      closeTo(await theoretical(ids[0], "theoryThrustRmse"), 19.6133);
      await page.locator("#mode-video").click(); await settle();
      assert.deepEqual(await theorySnapshot(), baseline);
      assert.equal(await page.locator("#theory-panel").isVisible(), true);
      await page.locator("#mode-analysis").click(); await settle();
      assert.equal(await cards.count(), 2);
      closeTo(await theoretical(ids[1], "theoryPressureRmse"), 1);
      await page.screenshot({ path: join(outputDir, "theory-analysis-desktop.png"), fullPage: true });
      await page.locator("#language-select").selectOption("en"); await settle();
    });

    await caseOf("video preview includes the shared theoretical profile and default burn annotations", async () => {
      await page.locator("#mode-video").click();
      await page.getByRole("button", { name: "Load demo", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("#timing-video-detail").textContent.includes("frames checked"), undefined, { timeout: 60000 });
      await page.locator("#source-video").evaluate((video) => video.pause()); await frame();
      assert.equal(await page.locator("#show-measurement").isChecked(), true);
      assert.equal(await page.locator("#show-measurement").isEnabled(), true);
      await setEnabled(true); const theoryOn = await image("preview");
      await setEnabled(false); const theoryOff = await image("preview");
      assert.notEqual(theoryOn, theoryOff, "The video preview must render the shared theoretical trace");
      await setEnabled(true);
      const alignedImages = new Set();
      for (const alignment of ["source", "ignition", "both"]) {
        await select("theory-alignment", alignment); alignedImages.add(await image("preview"));
      }
      assert.ok(alignedImages.size >= 2, "Video timing controls must update the theoretical trace position");
      await select("theory-alignment", "ignition");
      await page.locator("#tool-measurement").click(); await frame();
      const measurements = page.locator("#show-measurement"); await reveal(measurements);
      await measurements.uncheck(); await frame();
      const withoutMarkers = await image("preview");
      await measurements.check(); await frame();
      assert.notEqual(await image("preview"), withoutMarkers, "A/B and burn-duration annotations must affect the composed video");
      assert.deepEqual(await page.locator("#preview").evaluate((canvas) => [canvas.width, canvas.height]), [1920, 1080]);
      await page.evaluate(() => scrollTo(0, 0)); await frame();
      await page.screenshot({ path: join(outputDir, "theory-video-desktop.png"), fullPage: true });
    });

    await caseOf("MP4 export includes theoretical curves and burn annotations with preview parity", async () => {
      await page.locator("#tool-timeline").click();
      await change("trim-start", 1.5); await change("trim-end", 2.5);
      await page.getByRole("tab", { name: "Appearance", exact: true }).click();
      await page.locator('[data-theme="dark"]').click();
      await page.getByRole("tab", { name: "Export", exact: true }).click();
      await select("export-resolution", "1280"); await select("export-format", "mp4");
      await select("export-fps", "24");
      await page.locator("#keep-audio").uncheck(); await frame();
      await page.locator("#scrubber").evaluate((input) => {
        input.value = "2"; input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForFunction(() => {
        const video = document.querySelector("#source-video");
        return !video.seeking && Math.abs(video.currentTime - 2) < 0.002;
      });
      await frame();
      const expected = await page.locator("#preview").evaluate((preview) => {
        const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
        const context = canvas.getContext("2d"); context.drawImage(preview, 0, 0, canvas.width, canvas.height);
        const x = 0, y = Math.floor(canvas.height * 0.75), width = canvas.width, height = canvas.height - y;
        return { width: canvas.width, height: canvas.height, box: { x, y, width, height },
          pixels: Array.from(context.getImageData(x, y, width, height).data) };
      });
      assert.deepEqual([expected.width, expected.height], [1280, 720]);
      const event = page.waitForEvent("download", { timeout: 60000 });
      await page.locator("#export-button").click();
      const download = await event;
      const path = join(outputDir, "theory-export.mp4"); await download.saveAs(path);
      await page.waitForFunction(() => !document.querySelector("#export-dialog").open);
      const job = await page.evaluate(() => window.__theoryExportJobs.at(-1));
      assert.ok(job?.hasTheory, "The encoder worker must receive the theoretical profile");
      assert.equal(job.name, "theoretical-8kgf-1bar.csv");
      assert.equal(job.timeScale, 1); closeTo(job.force, 78.4532);
      assert.ok(job.measurement?.end > job.measurement?.start, "The encoder worker must receive both burn boundaries");
      closeTo(job.offset + 11, job.measurement.start, 1e-6);
      const buffer = await readFile(path);
      assert.ok(buffer.subarray(0, 64).includes(Buffer.from("ftyp")), "The export must be an MP4 container");
      const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryVideoTrack();
        assert.ok(track); assert.equal(await track.getDisplayWidth(), 1280); assert.equal(await track.getDisplayHeight(), 720);
        assert.equal(await input.getPrimaryAudioTrack(), null, "Disabled audio must not enter the theoretical overlay export");
        const duration = await input.computeDuration();
        assert.ok(duration >= 1 && duration < 1.1, `Expected a one-second trimmed export, received ${duration}`);
      } finally { input.dispose(); }
      const rendered = await page.evaluate(async (expected) => {
        const video = document.createElement("video"); video.muted = true; video.preload = "auto";
        video.src = document.querySelector("#download-again").href;
        await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
        await new Promise((resolve) => { video.onseeked = resolve; video.currentTime = 0.5; });
        const canvas = document.createElement("canvas"); canvas.width = expected.width; canvas.height = expected.height;
        const context = canvas.getContext("2d"); context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const { x, y, width, height } = expected.box;
        const actual = context.getImageData(x, y, width, height).data;
        let error = 0, count = 0;
        for (let index = 0; index < actual.length; index += 64)
          for (let channel = 0; channel < 3; channel++) { error += Math.abs(actual[index + channel] - expected.pixels[index + channel]); count++; }
        const gold = (pixels) => {
          let found = 0;
          for (let row = Math.ceil(expected.height * 0.82) - y; row < Math.floor(expected.height * 0.92) - y; row++)
            for (let column = Math.ceil(expected.width * 0.04); column < expected.width * 0.75; column++) {
              const index = (row * width + column) * 4;
              const red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
              if (red > 40 && green > 35 && green / red > 0.72 && blue < green * 0.8) found++;
            }
          return found;
        };
        const result = { error: error / count, previewGold: gold(expected.pixels), exportedGold: gold(actual), frame: canvas.toDataURL("image/png") };
        video.removeAttribute("src"); video.load();
        return result;
      }, expected);
      await writeFile(join(outputDir, "theory-export-frame.png"), Buffer.from(rendered.frame.split(",")[1], "base64"));
      assert.ok(rendered.error < 14, `Exported theoretical overlay differs from preview: ${rendered.error}`);
      assert.ok(rendered.previewGold > 20, `The preview must contain gold theoretical curve pixels: ${rendered.previewGold}`);
      assert.ok(rendered.exportedGold > Math.max(8, rendered.previewGold * 0.2),
        `The MP4 must contain theoretical curves, not only measured data: ${rendered.exportedGold}/${rendered.previewGold}`);
      console.log(`PASS: MP4 theoretical overlay parity (mean error ${rendered.error.toFixed(2)}, gold pixels ${rendered.exportedGold})`);
    });

    await caseOf("saving cannot silently omit enabled theory when either source lacks burn anchors", async () => {
      await select("theory-alignment", "ignition"); await setEnabled(true);
      await change("theory-start", ""); await change("theory-end", "");
      assert.equal(await page.locator("#export-button").isEnabled(), false, "Missing theoretical ignition must block an ignition-aligned export");
      assert.match(await page.locator("#save-status").textContent(), /A\/B.*Original CSV time.*disable theory/i);
      assert.equal(await page.locator("#theory-start").getAttribute("aria-invalid"), null, "A missing observed event is not a malformed source");
      await page.locator("#mode-analysis").click(); await settle();
      await select("profiles-alignment", "source");
      assert.equal(await page.locator("#profiles-theory-panel").isVisible(), true, "Valid raw theory must remain available in analysis");
      assert.equal(await cards.count(), 2);
      closeTo(await stat(ids[0], "impulse"), 196.133);
      await select("profiles-alignment", "ignition");
      await page.locator("#mode-video").click(); await settle();
      await select("theory-alignment", "source");
      assert.equal(await page.locator("#export-button").isEnabled(), true, "Explicit source-clock mapping does not require theoretical events");
      await select("theory-alignment", "ignition");
      assert.equal(await page.locator("#export-button").isEnabled(), false);
      await setEnabled(false);
      assert.equal(await page.locator("#export-button").isEnabled(), true, "Disabling an unmapped optional reference must allow measured-only exports");
      await change("theory-start", 11); await change("theory-end", 13); await setEnabled(true);
      assert.equal(await page.locator("#export-button").isEnabled(), true);
      await page.locator("#csv-input").setInputFiles({
        name: "video-measurement-without-events.csv", mimeType: "text/csv",
        buffer: Buffer.from("time_s;thrust;pressure\n0;10;2\n1;10;2\n2;10;2\n3;10;2\n4;10;2"),
      });
      await page.waitForFunction(() => document.querySelector("#csv-filename").textContent.includes("video-measurement-without-events.csv"));
      await frame();
      assert.equal(await page.locator("#measure-start").inputValue(), "");
      assert.equal(await page.locator("#measure-end").inputValue(), "");
      assert.equal(await page.locator("#export-button").isEnabled(), false, "Missing measured ignition must also block event-aligned theory exports");
      assert.match(await page.locator("#save-status").textContent(), /A\/B.*Original CSV time.*disable theory/i);
      await setEnabled(false);
      assert.equal(await page.locator("#export-button").isEnabled(), true);
      await setEnabled(true); await select("theory-alignment", "source");
      assert.equal(await page.locator("#export-button").isEnabled(), true, "Explicit source-clock mapping must also work without measured events");
      await page.locator("#mode-analysis").click(); await settle();
      closeTo(await theoretical(ids[0], "theoryThrustRmse"), 19.6133);
      closeTo(await theoretical(ids[1], "theoryPressureRmse"), 1);
      assert.equal(await cards.count(), 2, "Video event availability cannot change measured analysis records");
    });

    await caseOf("theoretical controls and separate plots remain usable on a narrow screen", async () => {
      await page.locator("#mode-analysis").click(); await page.locator("#language-select").selectOption("uk");
      await page.setViewportSize({ width: 390, height: 844 }); await settle();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "The theory workspace must fit 390 px without page overflow");
      for (const id of ["theory-panel", "theory-alignment", "profiles-chart", "profiles-pressure-chart", "profiles-theory-results"])
        assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} must remain usable on mobile`);
      closeTo(await theoretical(ids[0], "theoryThrustRmse"), 19.6133);
      await page.screenshot({ path: join(outputDir, "theory-analysis-mobile.png"), fullPage: true });
    });
  } finally { await page.close(); }
  return { failures, requests };
}
