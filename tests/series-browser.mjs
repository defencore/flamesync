import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// All sources are synthetic in-memory logs. Different absolute clocks and
// sampling rates deliberately prevent any comparison by row number.
function seriesCSV({ unit = "ms", rate = 50, offset = 0, force = 100, pressure = 2, gap = false } = {}) {
  const multiplier = { ms: 1000, us: 1000000, s: 1 }[unit];
  const rows = [`time_${unit};thrust;pressure`];
  for (let index = 0; index <= rate * 4; index++) {
    const time = index / rate;
    if (gap && time > 1.4 + 1e-9 && time < 2.6 - 1e-9) continue;
    const burning = time >= 1 && time <= 3;
    const clock = unit === "s" ? (offset + time).toFixed(9) : Math.round((offset + time) * multiplier);
    rows.push(`${clock};${burning ? force : 0};${burning ? pressure : 0}`);
  }
  return Buffer.from(rows.join("\n"));
}

const inputFile = (name, options) => ({ name, mimeType: "text/csv", buffer: seriesCSV(options) });
function closeTo(actual, expected, tolerance = 1e-6) {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance,
    `${actual} should equal ${expected} ± ${tolerance}`);
}

function reportRows(csv) {
  const rows = [], row = [];
  const source = csv.replace(/^\uFEFF/, "");
  let text = "", quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { text += '"'; index++; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) { row.push(text); text = ""; }
    else if (character === "\n" && !quoted) {
      row.push(text.replace(/\r$/, "")); rows.push([...row]); row.length = 0; text = "";
    } else text += character;
  }
  if (text || row.length) { row.push(text.replace(/\r$/, "")); rows.push([...row]); }
  const headers = rows.shift() ?? [];
  return rows.filter((cells) => cells.some(Boolean)).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}

/** Exercise series analysis only through public controls and rendered results. */
export async function verifySeries({ browser, baseURL, outputDir }) {
  const failures = [], requests = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: "en-US" });
  page.on("pageerror", (error) => failures.push(`Series analysis: ${error.message}`));
  page.on("console", (entry) => {
    if (entry.type() === "error") failures.push(`Series analysis: ${entry.text()}`);
  });
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  const cards = page.locator("#profiles-list [data-profile-id]");
  const ids = [];
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const settle = async () => {
    await frame();
    await page.waitForFunction(() => document.querySelector("#profile-analysis").getAttribute("aria-busy") !== "true");
    await frame();
  };
  const reveal = async (input) => {
    const ancestors = input.locator("xpath=ancestor::details");
    for (let index = 0; index < await ancestors.count(); index++) {
      const details = ancestors.nth(index);
      if (!await details.evaluate((element) => element.open)) await details.locator(":scope > summary").click();
    }
  };
  const field = (id, name) => page.locator(`#profiles-list [data-profile-id="${id}"] [data-field="${name}"]`);
  const setField = async (id, name, value) => {
    const input = field(id, name);
    await reveal(input); await input.fill(String(value)); await input.press("Tab"); await settle();
  };
  const select = async (id, value) => { await page.locator(`#${id}`).selectOption(value); await settle(); };
  const checkbox = async (id, name, checked) => {
    await field(id, name).setChecked(checked); await settle();
  };
  const value = async (locator) => {
    const raw = await locator.getAttribute("data-value");
    return raw === "" || raw === null ? null : Number(raw);
  };
  const summary = (key, stat) => value(page.locator(`#series-summary tr[data-series-stat="${key}"] [data-series-value="${stat}"]`));
  const member = (id, stat) => value(page.locator(`#series-members tr[data-profile-id="${id}"] [data-stat="${stat}"]`));
  const summarySnapshot = () => page.locator("#series-summary [data-series-value]").evaluateAll((cells) => cells.map((cell) => cell.dataset.value));
  const memberRow = (id) => page.locator(`#series-members tr[data-profile-id="${id}"]`);
  const caseOf = async (name, run) => {
    try { await run(); console.log(`PASS: ${name}`); }
    catch (error) {
      failures.push(`${name}: ${error.stack || error.message || String(error)}`);
      await page.screenshot({ path: join(outputDir, `series-failure-${failures.length}.png`), fullPage: true }).catch(() => {});
    }
  };

  try {
    await page.goto(baseURL);
    await page.locator("#language-select").selectOption("en");
    await page.locator("#mode-analysis").click();
    assert.equal(await page.locator("#profiles-source-thrust").inputValue(), "kgf");
    assert.equal(await page.locator("#profiles-thrust-unit").inputValue(), "kgf");
    await reveal(page.locator("#profiles-source-thrust"));
    await select("profiles-source-thrust", "N");
    await select("profiles-thrust-unit", "N");
    await select("profiles-mode", "series");
    await page.locator("#series-panel").waitFor({ state: "visible" });

    await caseOf("a test series loads without video and weighs independent acquisition rates equally", async () => {
      await page.locator("#profiles-input").setInputFiles([
        inputFile("series-01-50hz-ms.csv"),
        inputFile("series-02-120hz-us.csv", { rate: 120, unit: "us", offset: 10 }),
        inputFile("series-03-80hz-s.csv", { rate: 80, unit: "s", offset: 20 }),
        inputFile("series-04-120hz-ms.csv", { rate: 120, offset: 30 }),
        inputFile("series-05-high.csv", { rate: 50, unit: "us", offset: 40, force: 150, pressure: 3 }),
      ]);
      await settle();
      assert.equal(await cards.count(), 5);
      for (let index = 0; index < 5; index++) {
        const id = await cards.nth(index).getAttribute("data-profile-id");
        assert.ok(id); ids.push(id);
        assert.equal(await field(id, "included").isChecked(), true);
        await setField(id, "start", index * 10 + 1);
        await setField(id, "end", index * 10 + 3);
      }
      closeTo(await summary("duration", "n"), 5);
      closeTo(await summary("duration", "mean"), 2);
      closeTo(await summary("duration", "sd"), 0);
      closeTo(await summary("impulse", "n"), 5);
      closeTo(await summary("impulse", "mean"), 220);
      closeTo(await summary("impulse", "sd"), Math.sqrt(2000));
      closeTo(await summary("impulse", "cv"), Math.sqrt(2000) / 220 * 100);
      closeTo(await summary("impulse", "min"), 200);
      closeTo(await summary("impulse", "max"), 300);
      for (const metric of ["noiseThrustRms", "noisePressureRms", "noiseThrustPercent"]) {
        closeTo(await summary(metric, "n"), 5, 0);
        closeTo(await summary(metric, "mean"), 0, 0);
        closeTo(await summary(metric, "sd"), 0, 0);
        assert.equal(await summary(metric, "cv"), null, "Arithmetic residuals must not become relative variation on a zero-noise signal");
      }
      assert.equal(await page.locator("#source-video").getAttribute("src"), null);
    });

    await caseOf("per-test deviations and screening outliers use the selected series metric", async () => {
      await select("series-metric", "impulse");
      closeTo(await member(ids[0], "value"), 200);
      closeTo(await member(ids[0], "delta"), -20);
      closeTo(await member(ids[0], "percent"), -20 / 220 * 100);
      closeTo(await member(ids[0], "z"), -20 / Math.sqrt(2000));
      closeTo(await member(ids[4], "value"), 300);
      closeTo(await member(ids[4], "delta"), 80);
      closeTo(await member(ids[4], "percent"), 80 / 220 * 100);
      for (let index = 0; index < 5; index++)
        assert.equal(await memberRow(ids[index]).getAttribute("data-outlier"), String(index === 4));
      await select("series-metric", "meanPressure");
      closeTo(await summary("meanPressure", "mean"), 2.2);
      closeTo(await summary("meanPressure", "sd"), Math.sqrt(0.2));
      closeTo(await member(ids[4], "value"), 3);
      await select("series-metric", "impulse");
    });

    await caseOf("clock alignment and plotting visibility cannot change physical series results", async () => {
      const baseline = await summarySnapshot();
      for (const alignment of ["source", "ignition", "burnout", "normalized"]) {
        await select("profiles-alignment", alignment);
        assert.deepEqual(await summarySnapshot(), baseline, `${alignment} must retain original time and equal test weights`);
      }
      await checkbox(ids[4], "visible", false);
      assert.deepEqual(await summarySnapshot(), baseline, "Plot visibility is independent of series membership");
      await checkbox(ids[4], "visible", true);
      await select("profiles-thrust-unit", "kN");
      await select("profiles-pressure-unit", "MPa");
      assert.deepEqual(await summarySnapshot(), baseline, "Display units must not rewrite canonical SI summary data");
      await select("profiles-thrust-unit", "N");
      await select("profiles-pressure-unit", "bar");
      await select("profiles-alignment", "ignition");
      const initialImage = await page.locator("#profiles-chart").evaluate((canvas) => canvas.toDataURL());
      await select("series-band", "range");
      const rangeImage = await page.locator("#profiles-chart").evaluate((canvas) => canvas.toDataURL());
      await select("series-band", "sd");
      assert.notEqual(rangeImage, initialImage, "Range and standard deviation should produce different envelopes");
    });

    await caseOf("series membership recomputes dispersion without hiding or deleting the log", async () => {
      await checkbox(ids[4], "included", false);
      closeTo(await summary("impulse", "n"), 4);
      closeTo(await summary("impulse", "mean"), 200);
      closeTo(await summary("impulse", "sd"), 0);
      closeTo(await summary("impulse", "cv"), 0);
      assert.equal(await field(ids[4], "visible").isChecked(), true);
      assert.equal(await cards.count(), 5);
      assert.equal(await memberRow(ids[4]).getAttribute("data-outlier"), "false");
      for (let index = 1; index < 4; index++) await checkbox(ids[index], "included", false);
      closeTo(await summary("impulse", "n"), 1);
      closeTo(await summary("impulse", "mean"), 200);
      assert.equal(await summary("impulse", "sd"), null, "One test cannot estimate sample standard deviation");
      assert.equal(await summary("impulse", "cv"), null);
      await checkbox(ids[0], "included", false);
      closeTo(await summary("impulse", "n"), 0);
      assert.equal(await summary("impulse", "mean"), null);
      assert.equal(await summary("impulse", "sd"), null);
      for (const id of ids) await checkbox(id, "included", true);
      closeTo(await summary("impulse", "mean"), 220);
    });

    await caseOf("specific impulse reports its own valid sample count and needs consumed propellant mass", async () => {
      await select("series-metric", "specificImpulse");
      closeTo(await summary("specificImpulse", "n"), 0);
      assert.equal(await summary("specificImpulse", "mean"), null);
      await setField(ids[0], "mass", 500);
      closeTo(await summary("specificImpulse", "n"), 1);
      closeTo(await summary("specificImpulse", "mean"), 200 / (0.5 * 9.80665));
      assert.equal(await summary("specificImpulse", "sd"), null);
      await setField(ids[1], "mass", 500);
      closeTo(await summary("specificImpulse", "n"), 2);
      closeTo(await summary("specificImpulse", "sd"), 0);
      closeTo(await summary("impulse", "n"), 5, 0);
      await setField(ids[1], "mass", -1);
      assert.equal(await field(ids[1], "mass").getAttribute("aria-invalid"), "true");
      closeTo(await summary("specificImpulse", "n"), 1);
      closeTo(await summary("impulse", "n"), 4);
      assert.equal(await memberRow(ids[1]).getAttribute("data-eligible"), "false");
      await setField(ids[1], "mass", 500);
      closeTo(await summary("specificImpulse", "n"), 2);
      closeTo(await summary("impulse", "n"), 5, 0);
      const unfinishedMass = field(ids[1], "mass");
      await unfinishedMass.fill(""); await unfinishedMass.press("-"); await unfinishedMass.press("Tab"); await settle();
      assert.equal(await unfinishedMass.getAttribute("aria-invalid"), "true", "An unfinished numeric draft must not become an optional empty mass");
      closeTo(await summary("specificImpulse", "n"), 1);
      closeTo(await summary("impulse", "n"), 4);
      await setField(ids[1], "mass", 500);
      closeTo(await summary("specificImpulse", "n"), 2);
      closeTo(await summary("impulse", "n"), 5, 0);
      await select("series-metric", "impulse");
    });

    await caseOf("incomplete and malformed logs never bias complete-test series estimates", async () => {
      await page.locator("#profiles-input").setInputFiles([inputFile("series-incomplete.csv", { gap: true })]);
      await settle();
      const partial = await cards.filter({ hasText: "series-incomplete.csv" }).getAttribute("data-profile-id");
      assert.ok(partial);
      await setField(partial, "start", 1); await setField(partial, "end", 3);
      await setField(partial, "mass", 500);
      closeTo(await summary("impulse", "n"), 5);
      closeTo(await summary("impulse", "mean"), 220);
      assert.equal(await member(partial, "value"), null, "A partial impulse cannot be compared as a complete test");
      assert.equal(await memberRow(partial).getAttribute("data-outlier"), "false");
      const before = await summarySnapshot();
      await page.locator("#profiles-input").setInputFiles([{
        name: "series-malformed.csv", mimeType: "text/csv", buffer: Buffer.from("time_ms;thrust;pressure\n0;1;2\n0;2;3"),
      }]);
      await settle();
      assert.deepEqual(await summarySnapshot(), before);
      assert.equal(await cards.count(), 6);
      assert.match(await page.locator("#profiles-notice").textContent(), /series-malformed\.csv/);
    });

    await caseOf("series name and membership survive comparison, locale, and video mode switches", async () => {
      await page.locator("#series-name").fill("Acceptance series 2026-10");
      await page.locator("#series-name").press("Tab");
      const before = await summarySnapshot();
      await select("profiles-mode", "comparison");
      assert.equal(await page.locator("#series-panel").isVisible(), false);
      assert.equal(await cards.count(), 6);
      await select("profiles-mode", "series");
      assert.deepEqual(await summarySnapshot(), before);
      await page.locator("#language-select").selectOption("uk"); await settle();
      assert.deepEqual(await summarySnapshot(), before);
      assert.equal(await page.locator("#series-name").inputValue(), "Acceptance series 2026-10");
      assert.match(await page.locator("#series-panel").textContent(), /Сері|сері|Відхилення|відхилення|Парті|парті/);
      await page.locator("#mode-video").click();
      assert.equal(await page.locator("#profile-analysis").isVisible(), false);
      await page.locator("#mode-analysis").click(); await settle();
      assert.equal(await page.locator("#profiles-mode").inputValue(), "series");
      assert.deepEqual(await summarySnapshot(), before);
      await page.locator("#language-select").selectOption("en"); await settle();
    });

    await caseOf("series report downloads locally and includes reproducible statistics and test membership", async () => {
      const downloadEvent = page.waitForEvent("download");
      await page.locator("#series-export").click();
      const download = await downloadEvent;
      assert.match(download.suggestedFilename(), /\.csv$/i);
      const path = join(outputDir, "series-report.csv");
      await download.saveAs(path);
      const report = await readFile(path, "utf8");
      assert.ok(report.includes("Acceptance series 2026-10"));
      assert.ok(report.includes("series-01-50hz-ms.csv"));
      assert.ok(report.includes("series-05-high.csv"));
      assert.ok(report.includes("series-incomplete.csv"));
      assert.ok(!report.includes("series-malformed.csv"));
      assert.ok(!/NaN|Infinity|undefined/.test(report));
      assert.ok(report.includes("220"), "The report must contain the original-unit mean impulse");
      const exported = reportRows(report);
      const impulse = exported.find((row) => row.row_type === "metric" && row.metric === "impulse");
      assert.ok(impulse, "Summary rows must identify the statistic and canonical metric");
      closeTo(Number(impulse.n), 5);
      closeTo(Number(impulse.mean), 220);
      closeTo(Number(impulse.sd), Math.sqrt(2000));
      closeTo(Number(impulse.cv_percent), Math.sqrt(2000) / 220 * 100);
      assert.equal(impulse.metric_unit, "N·s");
      const outlier = exported.find((row) => row.row_type === "test" && row.metric === "impulse" && row.profile === "series-05-high.csv");
      assert.ok(outlier);
      closeTo(Number(outlier.value), 300); closeTo(Number(outlier.delta), 80);
      assert.equal(outlier.outlier, "true");
      const incomplete = exported.find((row) => row.row_type === "test" && row.profile === "series-incomplete.csv");
      assert.ok(incomplete && incomplete.exclusion_reason, "Excluded logs need a reproducible reason in the report");
      assert.equal(incomplete.eligible, "false");
      assert.ok(exported.every((row) => Object.hasOwn(row, "source_time_unit") && Object.hasOwn(row, "alignment")));
      const specificImpulse = exported.find((row) => row.row_type === "test" && row.metric === "specificImpulse" && row.profile === "series-01-50hz-ms.csv");
      assert.ok(specificImpulse);
      closeTo(Number(specificImpulse.propellant_g), 500, 0);
      closeTo(Number(specificImpulse.value), 200 / (0.5 * 9.80665));
      assert.equal(specificImpulse.metric_unit, "s");
    });

    await caseOf("series controls, plots, and horizontally scrolling tables fit desktop and mobile", async () => {
      await page.locator("#language-select").selectOption("uk"); await settle();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(outputDir, "series-analysis-desktop.png"), fullPage: true });
      for (const width of [1024, 390]) {
        await page.setViewportSize({ width, height: 844 }); await settle();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false,
          `Series mode must fit ${width}px without page overflow`);
        for (const id of ["series-panel", "series-summary", "series-members", "series-export", "profiles-chart", "profiles-difference"])
          assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} should remain usable at ${width}px`);
      }
      await page.screenshot({ path: join(outputDir, "series-analysis-mobile.png"), fullPage: true });
    });

    await caseOf("a folder import supports a series larger than the old comparison limit", async () => {
      const folder = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
      folder.on("pageerror", (error) => failures.push(`Series folder: ${error.message}`));
      folder.on("console", (entry) => { if (entry.type() === "error") failures.push(`Series folder: ${entry.text()}`); });
      folder.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
      try {
        await folder.goto(baseURL);
        await folder.locator("#language-select").selectOption("en");
        await folder.locator("#mode-analysis").click();
        await folder.locator("#profiles-source-thrust").evaluate((input) => {
          input.value = "N";
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await folder.locator("#profiles-mode").selectOption("series");
        assert.equal(await folder.locator("#series-folder").isVisible(), true);
        assert.equal(await folder.locator("#series-folder-input").getAttribute("webkitdirectory"), "");
        await folder.locator("#series-folder-input").evaluate((input, csv) => {
          const transfer = new DataTransfer();
          for (let index = 0; index < 14; index++) {
            const name = `folder-series-${String(index + 1).padStart(2, "0")}.csv`;
            const file = new File([csv], name, { type: "text/csv" });
            Object.defineProperty(file, "webkitRelativePath", { value: `Synthetic series/${name}` });
            transfer.items.add(file);
          }
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, seriesCSV().toString("utf8"));
        await folder.waitForFunction(() =>
          document.querySelector("#profile-analysis").getAttribute("aria-busy") !== "true" &&
          document.querySelectorAll("#profiles-list [data-profile-id]").length === 14);
        assert.equal(await folder.locator("#profiles-count").textContent(), "14 / 50");
        assert.equal(Number(await folder.locator('#series-summary [data-series-stat="impulse"] [data-series-value="n"]').getAttribute("data-value")), 14);
      } finally { await folder.close(); }
    });

    await caseOf("the series example presents a clean workspace with five independent tests", async () => {
      await page.setViewportSize({ width: 1440, height: 1050 });
      await page.locator("#profiles-clear").click(); await settle();
      await page.locator("#profiles-demo").click(); await settle();
      assert.equal(await cards.count(), 5);
      closeTo(await summary("impulse", "n"), 5);
      assert.ok(await summary("impulse", "mean") > 0);
      assert.equal(await page.locator("#profiles-notice").evaluate((element) => element.classList.contains("error")), false);
      await page.locator("#series-name").fill("Example series");
      await page.locator("#series-name").press("Tab");
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(outputDir, "series-examples-desktop.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 }); await settle();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: join(outputDir, "series-examples-mobile.png"), fullPage: true });
    });
  } finally { await page.close(); }
  return { failures, requests };
}
