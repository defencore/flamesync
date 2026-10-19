import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Synthetic sources deliberately use different absolute clocks and acquisition
// rates. No user recordings or logs are read, uploaded, or saved by this suite.
function csvFixture({ unit = "ms", rate = 50, offset = 0, level = null, gap = false, noisy = false } = {}) {
  const factor = { ms: 1000, us: 1000000, s: 1 }[unit];
  const rows = [`time_${unit};thrust;pressure`];
  for (let i = 0; i <= rate * 4; i++) {
    const local = i / rate;
    if (gap && local > 1.4 + 1e-9 && local < 2.6 - 1e-9) continue;
    const thrust = level ?? (local >= 1 && local <= 3 ? 100 : 0);
    const noise = noisy && local >= 1 && local <= 3 ? (i % 2 ? 2 : -2) : 0;
    const time = unit === "s" ? (offset + local).toFixed(9) : Math.round((offset + local) * factor);
    rows.push(`${time};${thrust + noise};${thrust > 0 ? 2 : 0}`);
  }
  return Buffer.from(rows.join("\n"));
}

function inputFile(name, buffer) {
  return { name, mimeType: "text/csv", buffer };
}

function closeTo(actual, expected, tolerance = 1e-6) {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected} ± ${tolerance}`);
}

function summaryRows(csv) {
  const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const delimiter = lines[0].includes(";") ? ";" : ",";
  const cells = (line) => line.split(delimiter).map((cell) => cell.replace(/^"|"$/g, "").replace(/""/g, '"'));
  const headers = cells(lines.shift());
  return lines.map((line) => Object.fromEntries(cells(line).map((value, i) => [headers[i], value])));
}

/** Verify profile analysis through its public controls and rendered results. */
export async function verifyProfiles({ browser, baseURL, fixture, outputDir }) {
  const failures = [];
  const requests = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: "en-US" });
  page.on("pageerror", (error) => failures.push(`Profile analysis: ${error.message}`));
  page.on("console", (entry) => {
    if (entry.type() === "error") failures.push(`Profile analysis: ${entry.text()}`);
  });
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  const panel = page.locator("#profile-analysis");
  const cards = page.locator("#profiles-list [data-profile-id]");
  const rows = page.locator("#profiles-table tbody tr[data-profile-id]");
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const settle = async () => {
    await frame();
    await page.waitForFunction(() => document.querySelector("#profile-analysis").getAttribute("aria-busy") !== "true");
    await frame();
  };
  const record = (name) => cards.filter({ hasText: name }).first();
  const profileId = async (name) => {
    const card = record(name);
    await card.waitFor();
    const id = await card.getAttribute("data-profile-id");
    assert.ok(id, `${name} needs an identifiable record`);
    return id;
  };
  const stat = async (id, key) => {
    const value = await page.locator(`#profiles-table tr[data-profile-id="${id}"] td[data-stat="${key}"]`).getAttribute("data-value");
    return value === "" || value === null ? null : Number(value);
  };
  const stats = (id) => page.locator(`#profiles-table tr[data-profile-id="${id}"]`).evaluate((element) => Object.fromEntries(
    [...element.querySelectorAll("[data-stat]")].map((cell) => [cell.dataset.stat, cell.dataset.value]),
  ));
  const reveal = async (input) => {
    const ancestors = input.locator("xpath=ancestor::details");
    for (let index = 0; index < await ancestors.count(); index++) {
      const details = ancestors.nth(index);
      if (!await details.evaluate((element) => element.open))
        await details.locator(":scope > summary").click();
    }
  };
  const setField = async (id, field, value) => {
    const input = page.locator(`#profiles-list [data-profile-id="${id}"] [data-field="${field}"]`);
    await reveal(input);
    await input.fill(String(value));
    await input.press("Tab");
    await settle();
  };
  const select = async (id, value) => {
    await page.locator(`#${id}`).selectOption(value);
    await settle();
  };
  const action = async (id, name) => {
    await page.locator(`#profiles-list [data-profile-id="${id}"] [data-action="${name}"]`).click();
    await settle();
  };
  const importFiles = async (files) => {
    await page.locator("#profiles-input").setInputFiles(files);
    await settle();
  };
  const canvasImage = (id = "profiles-chart") => page.locator(`#${id}`).evaluate((canvas) => canvas.toDataURL());
  const caseOf = async (name, run) => {
    try {
      await run();
      console.log(`PASS: ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error.stack || error.message || String(error)}`);
      await page.screenshot({ path: join(outputDir, `profiles-failure-${failures.length}.png`), fullPage: true }).catch(() => {});
    }
  };
  const videoSnapshot = () => page.evaluate(() => ({
    videoName: document.querySelector("#video-filename").textContent,
    logName: document.querySelector("#csv-filename").textContent,
    time: document.querySelector("#source-video").currentTime,
    paused: document.querySelector("#source-video").paused,
    fields: Object.fromEntries(["trim-start", "trim-end", "sync-offset", "stretch-percent"].map((id) => [id, document.getElementById(id).value])),
    frame: document.querySelector("#video-frame-number").textContent,
  }));
  const ids = {};
  try {
    await page.goto(baseURL);
    await page.locator("#language-select").selectOption("en");
    if (fixture) {
      await page.locator("#import-input").setInputFiles([
        { name: "preserved-video.webm", mimeType: "video/webm", buffer: fixture },
        inputFile("preserved-video-log.csv", csvFixture()),
      ]);
    } else {
      await page.getByRole("button", { name: "Load demo", exact: true }).click();
    }
    await page.waitForFunction(() => document.querySelector("#timing-video-detail").textContent.includes("frames checked"));
    await reveal(page.locator("#sync-offset"));
    for (const [id, value] of [["trim-start", "0.5"], ["trim-end", "3"], ["sync-offset", "0.25"]]) {
      await page.locator(`#${id}`).fill(value);
      await page.locator(`#${id}`).press("Tab");
      await frame();
    }
    await page.locator("#scrubber").evaluate((input) => {
      input.value = "1.5";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => !document.querySelector("#source-video").seeking);
    await frame();
    const initialVideo = await videoSnapshot();

    await caseOf("analysis mode isolates video edits and keyboard shortcuts", async () => {
      await page.locator("#mode-analysis").click();
      await panel.waitFor({ state: "visible" });
      assert.equal(await page.locator("#video-editor").isVisible(), false);
      await page.evaluate(() => document.activeElement?.blur());
      for (const key of ["Space", "ArrowRight", "ArrowLeft", "Home", "End", "i", "o", "s", process.platform === "darwin" ? "Meta+z" : "Control+z"])
        await page.keyboard.press(key);
      await settle();
      assert.deepEqual(await videoSnapshot(), initialVideo, "Analysis shortcuts must not seek, play, trim, align, or undo the video project");
    });

    await caseOf("comparison examples work without replacing the video project", async () => {
      await page.locator("#profiles-demo").click();
      await settle();
      assert.ok(await rows.count() >= 2, "Examples should provide multiple comparable profiles");
      assert.deepEqual(await videoSnapshot(), initialVideo);
      await page.locator("#profiles-clear").click();
      await settle();
      assert.equal(await rows.count(), 0);
      assert.equal(await cards.count(), 0);
    });

    await caseOf("multiple profiles preserve independent milliseconds, microseconds, seconds, and sample rates", async () => {
      await importFiles([
        inputFile("clock-ms-50hz.csv", csvFixture()),
        inputFile("clock-us-120hz.csv", csvFixture({ unit: "us", rate: 120, offset: 10 })),
        inputFile("clock-s-50hz.csv", csvFixture({ unit: "s", offset: 20 })),
        inputFile("constant-reference.csv", csvFixture({ level: 100 })),
        inputFile("constant-plus-ten.csv", csvFixture({ unit: "us", offset: 10, level: 110 })),
      ]);
      await page.waitForFunction(() => document.querySelectorAll("#profiles-table tbody tr[data-profile-id]").length === 5);
      for (const [name, key] of [["clock-ms-50hz.csv", "ms"], ["clock-us-120hz.csv", "us"], ["clock-s-50hz.csv", "s"], ["constant-reference.csv", "reference"], ["constant-plus-ten.csv", "candidate"]])
        ids[key] = await profileId(name);
      const automaticStart = Number(await page.locator(`#profiles-list [data-profile-id="${ids.ms}"] [data-field="start"]`).inputValue());
      await reveal(page.locator("#profiles-threshold"));
      await page.locator("#profiles-threshold").fill("10");
      await page.locator("#profiles-threshold").press("Tab");
      await settle();
      const adjustedStart = Number(await page.locator(`#profiles-list [data-profile-id="${ids.ms}"] [data-field="start"]`).inputValue());
      assert.ok(adjustedStart > automaticStart, "A higher threshold moves detected ignition later within the observed rise");
      await page.locator("#profiles-threshold").fill("5");
      await page.locator("#profiles-threshold").press("Tab");
      await settle();
      for (const [key, start, end] of [["ms", 1, 3], ["us", 11, 13], ["s", 21, 23], ["reference", 1, 3], ["candidate", 11, 13]]) {
        await setField(ids[key], "start", start);
        await setField(ids[key], "end", end);
        closeTo(await stat(ids[key], "duration"), 2);
        closeTo(await stat(ids[key], "meanThrust"), key === "candidate" ? 110 : 100);
        closeTo(await stat(ids[key], "impulse"), key === "candidate" ? 220 : 200);
      }
      assert.equal(await stat(ids.ms, "specificImpulse"), null, "Specific impulse needs propellant mass");
      await setField(ids.ms, "mass", 500);
      closeTo(await stat(ids.ms, "specificImpulse"), 200 / (0.5 * 9.80665));
      assert.equal(await cards.count(), 5);
    });

    await caseOf("alignment, traces, and display units preserve original duration and physical statistics", async () => {
      const baseline = await stats(ids.ms);
      const images = new Set();
      for (const alignment of ["source", "ignition", "burnout", "normalized"]) {
        await select("profiles-alignment", alignment);
        images.add(await canvasImage());
        assert.deepEqual(await stats(ids.ms), baseline, `${alignment} must not stretch source-clock statistics`);
      }
      assert.ok(images.size >= 3, "Alignment modes must update the plot coordinates");
      const raw = await canvasImage();
      await select("profiles-trace", "residual");
      assert.notEqual(await canvasImage(), raw);
      await select("profiles-trace", "trend");
      await select("profiles-trace", "raw");
      await select("profiles-thrust-unit", "kN");
      await select("profiles-pressure-unit", "MPa");
      closeTo(await stat(ids.ms, "meanThrust"), 100);
      closeTo(await stat(ids.ms, "peakPressure"), 2);
      const forceText = await page.locator(`#profiles-table tr[data-profile-id="${ids.ms}"] [data-stat="meanThrust"]`).textContent();
      assert.match(forceText, /0[.,]100|0[.,]1\b/, "Display force should convert 100 N to 0.1 kN");
      const pressureText = await page.locator(`#profiles-table tr[data-profile-id="${ids.ms}"] [data-stat="peakPressure"]`).textContent();
      assert.match(pressureText, /0[.,]200|0[.,]2\b/, "Display pressure should convert 2 bar to 0.2 MPa");
      await select("profiles-thrust-unit", "N");
      await select("profiles-pressure-unit", "bar");
      await select("profiles-metric", "pressure");
      await select("profiles-metric", "thrust");
      await select("profiles-alignment", "ignition");
    });

    await caseOf("per-file source units and constant-offset differences are independent", async () => {
      await select("profiles-reference", ids.ms);
      const other = await stats(ids.ms);
      const card = page.locator(`#profiles-list [data-profile-id="${ids.us}"]`);
      await reveal(card.locator('[data-field="thrustUnit"]'));
      await card.locator('[data-field="thrustUnit"]').selectOption("kgf");
      await card.locator('[data-field="pressureUnit"]').selectOption("MPa");
      await settle();
      closeTo(await stat(ids.us, "meanThrust"), 100 * 9.80665);
      closeTo(await stat(ids.us, "peakPressure"), 20);
      assert.deepEqual(await stats(ids.ms), other, "Changing one log's source units must preserve every other log");
      await card.locator('[data-field="thrustUnit"]').selectOption("N");
      await card.locator('[data-field="pressureUnit"]').selectOption("bar");
      await settle();
      await select("profiles-reference", ids.reference);
      closeTo(await stat(ids.candidate, "rmse"), 10);
      await select("profiles-alignment", "source");
      assert.equal(await stat(ids.candidate, "rmse"), null, "Disjoint source clocks must not invent overlapping data");
      await select("profiles-alignment", "ignition");
      closeTo(await stat(ids.candidate, "rmse"), 10);
      await select("profiles-alignment", "burnout");
      closeTo(await stat(ids.candidate, "rmse"), 10);
      await select("profiles-alignment", "normalized");
      closeTo(await stat(ids.candidate, "rmse"), 10);
      await select("profiles-alignment", "ignition");
      await importFiles([inputFile("reinterpret-ms.csv", csvFixture())]);
      ids.reinterpret = await profileId("reinterpret-ms.csv");
      const originalDuration = await stat(ids.reinterpret, "duration");
      const sourceTime = page.locator(`#profiles-list [data-profile-id="${ids.reinterpret}"] [data-field="timeUnit"]`);
      await reveal(sourceTime);
      await sourceTime.selectOption("us");
      await settle();
      closeTo(await stat(ids.reinterpret, "duration"), originalDuration / 1000, 1e-9);
      await sourceTime.selectOption("ms");
      await settle();
      closeTo(await stat(ids.reinterpret, "duration"), originalDuration);
    });

    await caseOf("noise statistics, missing boundaries, and invalid events remain explicit", async () => {
      await setField(ids.ms, "mass", -1);
      const mass = page.locator(`#profiles-list [data-profile-id="${ids.ms}"] [data-field="mass"]`);
      assert.equal(await mass.getAttribute("aria-invalid"), "true");
      assert.equal(await page.locator("#profiles-export").isDisabled(), true);
      await action(ids.ms, "detect");
      assert.equal(await mass.getAttribute("aria-invalid"), "true", "Detecting events must retain an invalid mass draft");
      assert.equal(await page.locator("#profiles-export").isDisabled(), true, "Automatic detection must not bypass mass validation");
      assert.equal(await stat(ids.ms, "specificImpulse"), null);
      await setField(ids.ms, "mass", 500);
      await setField(ids.ms, "start", 1);
      await setField(ids.ms, "end", 3);
      assert.equal(await page.locator("#profiles-export").isDisabled(), false);
      await reveal(page.locator("#profiles-noise-window"));
      await page.locator("#profiles-noise-window").fill("100");
      await page.locator("#profiles-noise-window").press("Tab");
      await settle();
      await setField(ids.reference, "noiseStart", 1.2);
      await setField(ids.reference, "noiseEnd", 2.8);
      closeTo(await stat(ids.reference, "noiseThrustRms"), 0, 1e-7);
      closeTo(await stat(ids.reference, "noisePressureRms"), 0, 1e-7);
      const end = page.locator(`#profiles-list [data-profile-id="${ids.reference}"] [data-field="end"]`);
      await setField(ids.reference, "end", "");
      assert.equal(await stat(ids.reference, "duration"), null, "A missing burnout cannot produce a duration");
      await setField(ids.reference, "end", 0.5);
      assert.equal(await stat(ids.reference, "duration"), null, "A reversed interval must not produce burn statistics");
      assert.ok(
        await end.getAttribute("aria-invalid") === "true" || /ignition|burnout|before|interval/i.test(await panel.textContent()),
        "An end before the start must be identified as invalid",
      );
      await setField(ids.reference, "end", 3);
      closeTo(await stat(ids.reference, "duration"), 2);
      await action(ids.reference, "detect");
      assert.equal(await stat(ids.reference, "duration"), null, "Constant positive thrust has no observed ignition or burnout");
      await setField(ids.reference, "start", 1);
      await setField(ids.reference, "end", 3);
      await importFiles([inputFile("noisy-combustion.csv", csvFixture({ noisy: true }))]);
      ids.noisy = await profileId("noisy-combustion.csv");
      await setField(ids.noisy, "start", 1);
      await setField(ids.noisy, "end", 3);
      await setField(ids.noisy, "noiseStart", 1.2);
      await setField(ids.noisy, "noiseEnd", 2.8);
      assert.ok(await stat(ids.noisy, "noiseThrustRms") > 0, "A varying signal must show nonzero residual RMS");
    });

    await caseOf("gaps and malformed worker imports preserve valid profiles without invented impulse", async () => {
      await importFiles([inputFile("missing-samples.csv", csvFixture({ gap: true }))]);
      ids.gap = await profileId("missing-samples.csv");
      await setField(ids.gap, "start", 1);
      await setField(ids.gap, "end", 3);
      await setField(ids.gap, "mass", 500);
      closeTo(await stat(ids.gap, "impulse"), 80);
      assert.equal(await stat(ids.gap, "specificImpulse"), null, "Incomplete coverage must not produce specific impulse");
      const known = await stats(ids.ms);
      await importFiles([inputFile("malformed-worker.csv", Buffer.from("time_ms;thrust;pressure\n0;10;2\n0;20;3"))]);
      await page.waitForFunction(() => document.querySelector("#profiles-notice").textContent.includes("malformed-worker.csv"));
      assert.deepEqual(await stats(ids.ms), known, "A malformed import must preserve previously analyzed data");
      assert.ok(await page.locator(`#profiles-table tr[data-profile-id="${ids.gap}"]`).isVisible());
    });

    await caseOf("profile visibility, chart event picking, reference fallback, and local CSV export", async () => {
      const visible = page.locator(`#profiles-list [data-profile-id="${ids.us}"] [data-field="visible"]`);
      await visible.uncheck();
      await settle();
      assert.equal(await visible.isChecked(), false);
      await visible.check();
      await settle();
      await select("profiles-alignment", "source");
      const oldStart = await page.locator(`#profiles-list [data-profile-id="${ids.ms}"] [data-field="start"]`).inputValue();
      await action(ids.ms, "pick-start");
      const chart = page.locator("#profiles-chart");
      await chart.scrollIntoViewIfNeeded();
      const box = await chart.boundingBox();
      assert.ok(box?.width && box?.height);
      await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.5);
      await page.waitForFunction(({ id, oldStart }) =>
        document.querySelector(`#profiles-list [data-profile-id="${id}"] [data-field="start"]`).value !== oldStart,
      { id: ids.ms, oldStart });
      await settle();
      const picked = await page.locator(`#profiles-list [data-profile-id="${ids.ms}"] [data-field="start"]`).inputValue();
      assert.notEqual(picked, oldStart, "Picking an ignition should update the selected profile event");
      await setField(ids.ms, "start", 1);
      await select("profiles-alignment", "ignition");
      await select("profiles-reference", ids.reference);
      await action(ids.reference, "remove");
      assert.notEqual(await page.locator("#profiles-reference").inputValue(), ids.reference);
      assert.equal(await page.locator(`#profiles-list [data-profile-id="${ids.reference}"]`).count(), 0);
      const downloadEvent = page.waitForEvent("download");
      await page.locator("#profiles-export").click();
      const download = await downloadEvent;
      assert.match(download.suggestedFilename(), /\.csv$/i);
      const path = join(outputDir, "profiles-summary.csv");
      await download.saveAs(path);
      const summary = await readFile(path, "utf8");
      for (const header of ["profile", "ignition_s", "burnout_s", "duration_s", "impulse_Ns", "specific_impulse_s", "coverage_percent", "rmse_N"])
        assert.ok(summary.includes(header), `${header} belongs in the portable summary`);
      assert.ok(summary.includes("clock-ms-50hz.csv"));
      assert.ok(summary.includes("missing-samples.csv"));
      assert.ok(!summary.includes("malformed-worker.csv"));
      assert.ok(!/NaN|Infinity|undefined/.test(summary));
      const records = summaryRows(summary);
      const known = records.find((entry) => entry.profile === "clock-ms-50hz.csv");
      const missing = records.find((entry) => entry.profile === "missing-samples.csv");
      assert.ok(known && missing);
      closeTo(Number(known.duration_s), 2);
      closeTo(Number(known.impulse_Ns), 200);
      closeTo(Number(known.specific_impulse_s), 200 / (0.5 * 9.80665), 1e-4);
      closeTo(Number(missing.coverage_percent), 40);
      assert.equal(missing.specific_impulse_s, "");
    });

    await caseOf("concurrent import batches respect the twelve-profile limit", async () => {
      const limited = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
      limited.on("pageerror", (error) => failures.push(`Profile limit: ${error.message}`));
      limited.on("console", (entry) => {
        if (entry.type() === "error") failures.push(`Profile limit: ${entry.text()}`);
      });
      limited.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
      try {
        await limited.goto(baseURL);
        await limited.locator("#language-select").selectOption("en");
        await limited.locator("#mode-analysis").click();
        await limited.locator("#profiles-input").evaluate((input, csv) => {
          // Submit both public file-input changes in one task, before any
          // worker reply can release the first batch's reserved capacity.
          for (let batch = 0; batch < 2; batch++) {
            const transfer = new DataTransfer();
            for (let index = 0; index < 8; index++)
              transfer.items.add(new File([csv], `batch-${batch}-${index}.csv`, { type: "text/csv" }));
            input.files = transfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }, csvFixture().toString("utf8"));
        await limited.waitForFunction(() =>
          document.querySelector("#profile-analysis").getAttribute("aria-busy") === "false" &&
          document.querySelectorAll("#profiles-table tbody tr[data-profile-id]").length === 12);
        assert.equal(await limited.locator("#profiles-list [data-profile-id]").count(), 12);
        assert.equal(await limited.locator("#profiles-count").textContent(), "12 / 12");
        assert.match(await limited.locator("#profiles-notice").textContent(), /12 CSV logs/);
      } finally {
        await limited.close();
      }
    });

    await caseOf("language and mode switches preserve analysis and video projects on desktop and mobile", async () => {
      const before = await stats(ids.ms);
      const selected = await page.locator("#profiles-reference").inputValue();
      await page.locator("#language-select").selectOption("uk");
      await settle();
      assert.deepEqual(await stats(ids.ms), before);
      assert.equal(await page.locator("#profiles-reference").inputValue(), selected);
      assert.match(await panel.textContent(), /Тяга|Імпульс|Профілі|Профіль|Порівняння/);
      assert.match(await page.locator("#profiles-notice").textContent(), /часові мітки мають зростати/, "An existing import error must switch language with the interface");
      await page.locator("#mode-video").click();
      assert.equal(await panel.isVisible(), false);
      const restored = await videoSnapshot();
      assert.deepEqual(restored.fields, initialVideo.fields);
      assert.equal(restored.videoName, initialVideo.videoName);
      assert.equal(restored.logName, initialVideo.logName);
      assert.equal(restored.frame, initialVideo.frame);
      assert.equal(restored.paused, true);
      await page.locator("#mode-analysis").click();
      await settle();
      assert.deepEqual(await stats(ids.ms), before);
      await page.screenshot({ path: join(outputDir, "profiles-analysis-desktop.png"), fullPage: true });
      for (const width of [1024, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await settle();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Analysis must fit ${width}px without page overflow`);
        assert.ok(await page.locator("#profiles-chart").isVisible());
        assert.ok(await page.locator("#profiles-export").isVisible());
      }
      await page.screenshot({ path: join(outputDir, "profiles-analysis-mobile.png"), fullPage: true });
    });
    await caseOf("comparison examples present a clean analysis workspace", async () => {
      await page.setViewportSize({ width: 1440, height: 1050 });
      await page.locator("#profiles-clear").click();
      await settle();
      await page.locator("#profiles-demo").click();
      await settle();
      const exampleIds = await cards.evaluateAll((elements) => elements.map((element) => element.dataset.profileId));
      assert.equal(exampleIds.length, 2);
      for (const id of exampleIds) await setField(id, "mass", 200);
      await select("profiles-alignment", "normalized");
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(outputDir, "profiles-comparison-desktop.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await settle();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: join(outputDir, "profiles-comparison-mobile.png"), fullPage: true });
    });
  } finally {
    await page.close();
  }
  return { failures, requests };
}
