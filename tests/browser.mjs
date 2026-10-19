import assert from "node:assert/strict";
import { verifyFrameStepping } from "./frame-stepping-browser.mjs";
import { verifyEditorWorkflow } from "./editor-workflow.mjs";
import { verifyProfiles } from "./profile-browser.mjs";
import { verifySeries } from "./series-browser.mjs";
import { verifyTheory } from "./theory-browser.mjs";
import { verifyTemplates } from "./templates-browser.mjs";
import { mkdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { compositionGeometry } from "../src/composition.js";
import { defaultStyle, overlayHeight } from "../src/overlay.js";
import {
  Input,
  BufferSource,
  ALL_FORMATS,
  EncodedPacketSink,
} from "mediabunny";

const baseURL = process.argv[2] || "http://localhost:8080";
const origin = new URL(baseURL).origin;
const outputDir =
  process.env.TEST_RESULTS_DIR ||
  (await mkdtemp(join(tmpdir(), "flamesync-qa-")));
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || "chrome",
  headless: true,
});
const failures = [];
const requests = [];
const page = await browser.newPage({
  viewport: { width: 1440, height: 1050 },
  locale: "en-US",
});
page.on("pageerror", (error) => failures.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") failures.push(message.text());
});
page.on("request", (request) =>
  requests.push({ url: request.url(), method: request.method() }),
);

async function settle(target = page) {
  // Allow the browser to present pending UI updates before inspecting them.
  await target.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
async function openEditor(target = page) {
  await target.goto(baseURL);
  await select("language-select", "en", target);
  assert.equal(await target.locator("#source-thrust-unit").inputValue(), "kgf");
  assert.equal(await target.locator("#source-pressure-unit").inputValue(), "bar");
  assert.equal(await target.locator("#thrust-unit").inputValue(), "kgf");
  assert.equal(await target.locator("#pressure-unit").inputValue(), "bar");
  assert.equal(await target.locator("#show-measurement").isChecked(), true);
  // These regression fixtures contain Newtons. Select their units explicitly;
  // the user-facing import and output defaults remain kilogram-force and bar.
  await target.locator("#csv-settings").evaluate((element) => { element.open = true; });
  await select("source-thrust-unit", "N", target);
  await target.locator("#csv-settings").evaluate((element) => { element.open = false; });
  await target.getByRole("tab", { name: "Appearance", exact: true }).click();
  await select("thrust-unit", "N", target);
  await target.getByRole("tab", { name: "Project", exact: true }).click();
}
async function change(id, value, target = page) {
  await target.locator(`#${id}`).fill(String(value));
  await target.locator(`#${id}`).press("Tab");
  await settle(target);
}
async function click(id, target = page) {
  await target.locator(`#${id}`).click();
  await settle(target);
}
async function select(id, value, target = page) {
  await target.locator(`#${id}`).selectOption(value);
  await settle(target);
}
async function seek(time, target = page) {
  await target.locator("#scrubber").evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, time);
  await target.waitForFunction((time) => {
    const video = document.querySelector("#source-video");
    return !video.seeking && Math.abs(video.currentTime - time) < 0.001;
  }, time);
  // Wait until the compositor has presented the frame after the seek event.
  await target.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

async function compositionRegions(target = page) {
  const source = await target.evaluate(() => {
    const canvas = document.querySelector("#preview");
    const video = document.querySelector("#source-video");
    return {
      width: canvas.width,
      height: canvas.height,
      sourceWidth: video.videoWidth || 1920,
      sourceHeight: video.videoHeight || 1080,
      style: {
        height: Number(document.querySelector("#overlay-height").value),
        layout: document.querySelector("#presentation-layout").value,
        showDetails: document.querySelector("#show-details").checked,
        showPressure: document.querySelector("#show-pressure").checked,
        showImpulse: document.querySelector("#show-impulse").checked,
      },
    };
  });
  const style = { ...defaultStyle, ...source.style };
  const geometry = compositionGeometry(
    source.width,
    source.height,
    source.sourceWidth,
    source.sourceHeight,
    style,
  );
  const panelHeight = overlayHeight(source.width, source.height, style);
  const panelY = Math.floor(source.height - panelHeight);
  const integerRect = (box) => {
    const x = Math.ceil(box.x),
      y = Math.ceil(box.y);
    return {
      x,
      y,
      width: Math.floor(box.x + box.width) - x,
      height: Math.floor(box.y + box.height) - y,
    };
  };
  return {
    width: source.width,
    height: source.height,
    panelPosition: Number((1 - panelHeight / source.height).toFixed(10)),
    panel: {
      x: 0,
      y: panelY,
      width: source.width,
      height: source.height - panelY,
    },
    details: geometry.info && integerRect(geometry.info),
  };
}

async function regionPixels(target, region) {
  return target.locator("#preview").evaluate(
    (canvas, box) => ({
      width: canvas.width,
      height: canvas.height,
      region: box,
      values: Array.from(
        canvas.getContext("2d").getImageData(box.x, box.y, box.width, box.height)
          .data,
      ),
    }),
    region,
  );
}

async function verifyDefaultFullHD(fixture) {
  const editor = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    locale: "en-US",
  });
  editor.on("pageerror", (error) => failures.push(`FullHD default: ${error.message}`));
  editor.on("console", (entry) => {
    if (entry.type() === "error") failures.push(`FullHD default: ${entry.text()}`);
  });
  editor.on("request", (request) =>
    requests.push({ url: request.url(), method: request.method() }),
  );
  try {
    await openEditor(editor);
    await editor.locator("#import-input").setInputFiles([
      { name: "fullhd-small-source.webm", mimeType: "video/webm", buffer: fixture },
      {
        name: "fullhd-local.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("time_ms;thrust;pressure\n0;0;0\n100;100;2\n300;0;0"),
      },
    ]);
    await editor.waitForFunction(() =>
      document.querySelector("#timing-video-detail").textContent.includes("frames checked") &&
      !document.querySelector("#export-button").disabled,
    );
    assert.equal(await editor.locator("#frame-aspect").inputValue(), "landscape");
    assert.equal(await editor.locator("#export-resolution").inputValue(), "1920");
    assert.deepEqual(
      await editor.locator("#preview").evaluate((canvas) => [canvas.width, canvas.height]),
      [1920, 1080],
      "A source smaller than FullHD must still preview the default FullHD composition",
    );
    await change("trim-end", 0.3, editor);
    const downloadEvent = editor.waitForEvent("download", { timeout: 60000 });
    await click("save-video", editor);
    const path = join(outputDir, "default-fullhd.mp4");
    await (await downloadEvent).saveAs(path);
    await editor.waitForFunction(() => !document.querySelector("#export-dialog").open);
    const input = new Input({
      source: new BufferSource(new Uint8Array(await readFile(path))),
      formats: ALL_FORMATS,
    });
    try {
      const track = await input.getPrimaryVideoTrack();
      assert.ok(track);
      assert.equal(await track.getDisplayWidth(), 1920);
      assert.equal(await track.getDisplayHeight(), 1080);
      const duration = await input.computeDuration();
      assert.ok(duration >= 0.299 && duration < 0.4, `Unexpected FullHD clip duration ${duration}`);
    } finally {
      input.dispose();
    }
    console.log("PASS: default export from a smaller source is actual 1920 × 1080, 16:9");
  } finally {
    await editor.close();
  }
}

async function verifyLocalization(fixture) {
  const editor = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  editor.on("pageerror", (error) => failures.push(error.message));
  editor.on("console", (entry) => {
    if (entry.type() === "error") failures.push(entry.text());
  });
  editor.on("request", (request) =>
    requests.push({ url: request.url(), method: request.method() }),
  );
  await editor.goto(baseURL);
  await editor
    .getByRole("heading", { name: "Редактор відео й телеметрії" })
    .waitFor();
  assert.equal(await editor.locator("html").getAttribute("lang"), "uk");
  assert.equal(await editor.locator("#language-select").inputValue(), "uk");
  assert.equal(await editor.locator("[data-save-video]").count(), 2);
  assert.match(
    await editor.locator("#save-status").textContent(),
    /Додайте відео та CSV/,
  );
  assert.equal(await editor.locator("#save-video").isEnabled(), false);
  assert.equal(
    await editor
      .locator("#more-test-details > summary > [data-i18n]")
      .isVisible(),
    true,
  );
  assert.equal(
    await editor
      .locator("#save-settings")
      .textContent()
      .then((s) => s.trim()),
    "Формат і якість",
  );
  await editor.screenshot({
    path: `${outputDir}/ukrainian-empty.png`,
    fullPage: true,
  });

  await editor.locator("#csv-input").setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("time_ms;thrust;pressure\n0;1;1\n0;2;2"),
  });
  await editor.waitForFunction(() =>
    document.querySelector("#notice").textContent.includes("Рядок 3"),
  );
  await select("language-select", "en", editor);
  assert.match(
    await editor.locator("#notice").textContent(),
    /Line 3: timestamps must increase strictly/,
  );
  await select("language-select", "uk", editor);
  assert.match(
    await editor.locator("#notice").textContent(),
    /Рядок 3: часові мітки/,
  );

  await editor.locator("#csv-input").setInputFiles({
    name: "телеметрія.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "time_us;thrust;pressure\n100000;0;0\n200000;100;2\n300000;80;2\n400000;0;0\n500000;0;0",
    ),
  });
  await editor.waitForFunction(
    () => !document.querySelector("#measure-start").disabled,
  );
  assert.match(
    await editor.locator("#save-status").textContent(),
    /Додайте відео/,
  );
  await editor.locator("#video-input").setInputFiles({
    name: "локальне-відео.webm",
    mimeType: "video/webm",
    buffer: fixture,
  });
  await editor.waitForFunction(
    () =>
      Number(
        document
          .querySelector("#video-frame-count")
          .textContent.replaceAll(",", ""),
      ) > 0,
  );
  await editor.locator("#meta-motor").fill("Motor A / дослідний");
  await editor.locator("#meta-testDate").fill("2026-10-17");
  await editor.locator("#meta-testDate").press("Tab");
  await editor.locator(".sync-adjustments > summary").press("Enter");
  await editor.locator("#analysis-controls > summary").press("Enter");
  await change("stretch-percent", 200, editor);
  await change("sync-offset", 1, editor);
  await change("trim-start", 1, editor);
  await change("trim-end", 4, editor);
  await seek(1.5, editor);
  await click("tool-measurement", editor);
  await change("measure-start", 0.15, editor);
  await change("measure-end", 0.35, editor);
  assert.equal(
    await editor.locator("#measure-duration").textContent(),
    "0.200 с",
  );
  assert.match(
    await editor.locator("#save-status").textContent(),
    /Готово до збереження/,
  );
  assert.equal(await editor.locator("#save-video").isEnabled(), true);

  const stateSnapshot = () =>
    editor.evaluate(() => ({
      inputs: Object.fromEntries(
        [
          "meta-motor",
          "meta-testDate",
          "trim-start",
          "trim-end",
          "sync-offset",
          "stretch-percent",
          "measure-start",
          "measure-end",
          "source-thrust-unit",
          "source-pressure-unit",
          "csv-time-unit",
        ].map((id) => [id, document.getElementById(id).value]),
      ),
      filenames: ["csv-filename", "video-filename"].map(
        (id) => document.getElementById(id).textContent,
      ),
      time: document.querySelector("#source-video").currentTime,
      frame: document.querySelector("#video-frame-number").textContent,
      logRow: document.querySelector("#video-log-row").textContent,
      preview: document.querySelector("#preview").toDataURL(),
    }));
  const before = await stateSnapshot();
  const aboutFrames = editor.locator(
    '[data-i18n-aria-label="About source frames"]',
  );
  await aboutFrames.click();
  assert.match(
    await editor.locator("#info-tooltip").textContent(),
    /Кадри нумеруються від 1/,
  );
  await select("language-select", "en", editor);
  assert.equal(await editor.locator("#info-tooltip").isVisible(), false);
  assert.equal(await aboutFrames.getAttribute("aria-describedby"), null);
  assert.equal(
    await editor.locator("#measure-duration").textContent(),
    "0.200 s",
  );
  assert.deepEqual(
    await stateSnapshot(),
    before,
    "Language changes must preserve files, user metadata, frame selection, synchronization, measurement, and rendered output.",
  );
  await select("language-select", "uk", editor);
  assert.deepEqual(await stateSnapshot(), before);
  assert.equal(
    await editor.locator("#meta-testDate").inputValue(),
    "2026-10-17",
  );
  await editor.evaluate(() => window.scrollTo(0, 0));
  await editor.screenshot({
    path: `${outputDir}/ukrainian-editor.png`,
    fullPage: true,
  });

  await click("save-settings", editor);
  assert.equal(
    await editor.locator("#tab-export").getAttribute("aria-selected"),
    "true",
  );
  assert.equal(
    await editor
      .locator("#export-format")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await select("export-resolution", "1280", editor);
  await select("export-format", "mp4", editor);
  const downloadEvent = editor.waitForEvent("download", { timeout: 60000 });
  await click("save-video", editor);
  assert.match(await editor.locator("#export-dialog").textContent(), /відео/);
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /-flamesync\.mp4$/);
  await download.saveAs(`${outputDir}/ukrainian-export.mp4`);
  await editor.waitForFunction(
    () => !document.querySelector("#export-dialog").open,
  );
  assert.match(await editor.locator("#notice").textContent(), /Відео готове/);
  assert.equal(await editor.locator("#download-again").isVisible(), true);
  const repeat = editor.waitForEvent("download");
  await click("download-again", editor);
  assert.equal(
    (await repeat).suggestedFilename(),
    download.suggestedFilename(),
  );

  for (const width of [1024, 390, 360]) {
    await editor.setViewportSize({ width, height: 844 });
    await editor.evaluate(() => window.scrollTo(0, 0));
    assert.equal(
      await editor.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `Ukrainian UI must fit ${width}px.`,
    );
    assert.equal(await editor.locator("#export-button").isVisible(), true);
    await click("help-open", editor);
    assert.equal(await editor.locator("#help-dialog").isVisible(), true);
    await click("help-close", editor);
    await click("tool-timeline", editor);
    await editor.locator("#trim-start").scrollIntoViewIfNeeded();
    const clearTrim = await editor.locator("#trim-start").evaluate((input) => {
      const rect = input.getBoundingClientRect();
      return input.contains(
        document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        ),
      );
    });
    assert.equal(
      clearTrim,
      true,
      "The save action must not cover trim controls.",
    );
    if (width <= 700) {
      const positions = await editor.evaluate(() =>
        ["trim-start", "set-in", "trim-end", "set-out"].map((id) => {
          const box = document.getElementById(id).getBoundingClientRect();
          return { x: box.x, y: box.y, height: box.height };
        }),
      );
      assert.ok(Math.abs(positions[0].y - positions[1].y) < 2);
      assert.ok(Math.abs(positions[2].y - positions[3].y) < 2);
      assert.ok(positions[2].y >= positions[0].y + positions[0].height);
    }
    await editor.evaluate(() => window.scrollTo(0, 0));
    if (width === 390)
      await editor.screenshot({
        path: `${outputDir}/ukrainian-mobile.png`,
        fullPage: true,
      });
  }
  await select("language-select", "en", editor);
  await editor.reload();
  assert.equal(await editor.locator("html").getAttribute("lang"), "en");
  await select("language-select", "uk", editor);
  await editor.reload();
  assert.equal(await editor.locator("html").getAttribute("lang"), "uk");
  assert.equal(
    await editor.locator("#video-filename").textContent(),
    "Додати відео",
  );
  assert.deepEqual(
    await editor.evaluate(() => Object.keys(localStorage)),
    ["flamesync.language"],
    "Only the language preference is persisted.",
  );
  await editor.close();
  console.log(
    "PASS: Ukrainian default and persistence; live bilingual errors, tooltips, and controls; preserved media and sync; visible save actions and actual MP4 download; responsive 360/390/1024px layout",
  );
}

async function verifyIgnitionAlignment(fixture) {
  const editor = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  editor.on("pageerror", (error) => failures.push(error.message));
  await openEditor(editor);
  await editor.locator("#import-input").setInputFiles([
    { name: "local.webm", mimeType: "video/webm", buffer: fixture },
    {
      name: "nonzero-start.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "time_ms;thrust;pressure\n1000;0;0\n1100;0;0\n1200;100;2\n1300;80;2\n1400;0;0\n1500;0;0",
      ),
    },
  ]);
  await editor.waitForFunction(
    () =>
      !document.querySelector("#frame-next").disabled &&
      !document.querySelector("#align-ignition").disabled,
  );
  await editor.locator(".sync-adjustments > summary").press("Enter");
  await editor.locator("#analysis-controls > summary").press("Enter");
  const anchor = Number(await editor.locator("#csv-anchor").inputValue());
  for (const scale of [100, 200, 50]) {
    await change("stretch-percent", scale, editor);
    const requestedTime = await editor.evaluate(() => {
      const input = document.querySelector("#scrubber");
      for (const time of [1.1, 5.1, 4.678]) {
        input.value = String(time);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      document
        .querySelector("#source-video")
        .dispatchEvent(new Event("timeupdate"));
      document.querySelector("#align-ignition").click();
      return Number(input.value);
    });
    assert.equal(
      requestedTime,
      4.678,
      "Intermediate media events must retain the last requested playhead position.",
    );
    await editor.waitForFunction(
      () =>
        !document.querySelector("#source-video").seeking &&
        Math.abs(document.querySelector("#source-video").currentTime - 4.678) <
          0.002,
    );
    await settle(editor);
    const time = Number(
      (await editor.locator("#video-frame-time").textContent()).replace(
        " s",
        "",
      ),
    );
    const offset = Number(await editor.locator("#sync-offset").inputValue());
    assert.ok(
      Math.abs(offset + (anchor * scale) / 100 - time) < 0.000002,
      `Align ignition must use the final requested frame at ${scale}%: offset ${offset}, anchor ${anchor}, frame ${time}`,
    );
    const cursorError = await editor.evaluate(() => {
      const ignition = document
        .querySelector("#timeline-ignition")
        .getBoundingClientRect();
      const cursor = document
        .querySelector("#timeline-playhead")
        .getBoundingClientRect();
      return Math.abs(ignition.left - (cursor.left + cursor.width / 2));
    });
    assert.ok(
      cursorError < 0.75,
      `Ignition marker must land on the playhead, not to its side: ${cursorError}px`,
    );
    const before = await editor.locator("#sync-offset").inputValue();
    await click("align-ignition", editor);
    assert.equal(
      await editor.locator("#sync-offset").inputValue(),
      before,
      "Repeated alignment must not drift.",
    );
    assert.equal(
      await editor.locator("#stretch-percent").inputValue(),
      `${scale}.000`,
    );
  }
  await change("stretch-percent", 200, editor);
  await seek(0.5, editor);
  await click("align-ignition", editor);
  assert.ok(
    Number(await editor.locator("#sync-offset").inputValue()) < 0,
    "Early video events must allow a negative offset.",
  );
  await seek(2, editor);
  await click("play-button", editor);
  await editor.waitForFunction(
    () => document.querySelector("#source-video").currentTime > 2.15,
  );
  await click("align-ignition", editor);
  assert.equal(
    await editor.locator("#source-video").evaluate((v) => v.paused),
    true,
    "Align here must freeze the selected frame.",
  );
  const frame = Number(
    (await editor.locator("#video-frame-time").textContent()).replace(" s", ""),
  );
  const offset = Number(await editor.locator("#sync-offset").inputValue());
  assert.ok(Math.abs(offset + anchor * 2 - frame) < 0.000002);
  await editor.evaluate(() => window.scrollTo(0, 0));
  await editor.screenshot({
    path: `${outputDir}/ignition-alignment.png`,
    fullPage: true,
  });
  await editor.close();
  console.log(
    "PASS: ignition alignment waits for the last queued seek, freezes playback, preserves 50/100/200% scale, supports negative offsets, and stays idempotent",
  );
}

async function verifyPlayheadGeometry(target) {
  const originalViewport = target.viewportSize();
  const duration = await target
    .locator("#source-video")
    .evaluate((video) => video.duration);
  for (const width of [1440, 1024, 390]) {
    await target.setViewportSize({ width, height: 1050 });
    await target.locator("#scrubber").scrollIntoViewIfNeeded();
    for (const fraction of [0, 0.25, 0.5, 0.9]) {
      await seek(duration * fraction, target);
      const geometry = await target.evaluate(() => {
        const range = document.querySelector("#scrubber");
        const input = range.getBoundingClientRect();
        const rail = document
          .querySelector("#scrubber-rail")
          .getBoundingClientRect();
        const tracks = document
          .querySelector("#tracks-body")
          .getBoundingClientRect();
        const line = document
          .querySelector("#timeline-playhead")
          .getBoundingClientRect();
        const thumb = parseFloat(
          getComputedStyle(range).getPropertyValue("--thumb-size"),
        );
        const progress =
          (Number(range.value) - Number(range.min)) /
          (Number(range.max) - Number(range.min));
        return {
          startError: rail.left - tracks.left,
          widthError: rail.width - tracks.width,
          thumbError:
            input.left +
            thumb / 2 +
            progress * (input.width - thumb) -
            (line.left + line.width / 2),
        };
      });
      for (const [key, error] of Object.entries(geometry))
        assert.ok(
          Math.abs(error) < 0.7,
          `Playhead ${key} at ${width}px / ${fraction}: ${error}px`,
        );
    }
    const rail = await target.locator("#scrubber-rail").boundingBox();
    await target.mouse.click(
      rail.x + rail.width * 0.6,
      rail.y + rail.height / 2,
    );
    await target.waitForFunction(
      () => !document.querySelector("#source-video").seeking,
    );
    const time = await target
      .locator("#source-video")
      .evaluate((video) => video.currentTime);
    assert.ok(
      Math.abs(time - duration * 0.6) < 0.03,
      `Pointer position must use the track's clock at ${width}px: ${time}`,
    );
  }
  await target.setViewportSize(originalViewport);
  await target.evaluate(() => window.scrollTo(0, 0));
  console.log(
    "PASS: playhead thumb, pointer seeking, and VIDEO/CSV cursor share one scale at desktop, tablet, and mobile widths",
  );
}

async function telemetryPanelPosition(target) {
  const { panel, panelPosition } = await compositionRegions(target);
  const edge = await target.locator("#preview").evaluate(
    (canvas, box) => {
      const context = canvas.getContext("2d");
      const pixels = context.getImageData(0, box.y, 1, 5).data;
      const body = context.getImageData(0, box.y + 6, 1, 1).data;
      return {
        pixels: Array.from(pixels),
        body: Array.from(body),
      };
    },
    panel,
  );
  assert.ok(edge.body.every(Number.isFinite));
  assert.equal(edge.body[3], 255, "The reserved telemetry panel must be opaque.");
  assert.ok(
    edge.pixels.slice(0, 20).some((value, index) => value !== edge.body[index % 4]),
    "The telemetry panel's top rule must remain visible in the actual canvas.",
  );
  // Importing a smaller source can resize the preview. Compare the true
  // normalized boundary and opaque fill, excluding pixel rounding at its rule.
  return { position: panelPosition, body: edge.body };
}

async function verifyImportOrder(fixture) {
  const editor = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  editor.on("pageerror", (error) => failures.push(error.message));
  const log = {
    name: "telemetry.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "time_ms;thrust;pressure\n0;0;0\n500;100;5\n1000.4;0;0",
    ),
  };
  const video = {
    name: "local-fixture.webm",
    mimeType: "video/webm",
    buffer: fixture,
  };
  for (const order of ["video-first", "csv-first"]) {
    await openEditor(editor);
    const initial = await telemetryPanelPosition(editor);
    assert.ok(
      initial.position > 0.45 && initial.position < 0.9,
      "Empty editor must retain a visible telemetry panel.",
    );
    if (order === "csv-first") {
      await editor.locator("#csv-input").setInputFiles(log);
      await editor.waitForFunction(() =>
        document.querySelector("#csv-drop").classList.contains("loaded"),
      );
    }
    await editor.locator("#video-input").setInputFiles(video);
    await editor.waitForFunction(
      () =>
        document.querySelector("#video-drop").classList.contains("loaded") &&
        document.querySelector("#source-video").readyState >= 2,
    );
    assert.deepEqual(
      await telemetryPanelPosition(editor),
      initial,
      `${order}: importing video must not remove or displace the telemetry panel.`,
    );
    if (order === "video-first") {
      assert.equal(
        await editor.locator("#preview-tag").textContent(),
        "AWAITING CSV",
      );
      assert.equal(await editor.locator("#export-button").isEnabled(), false);
      await click("play-button", editor);
      await editor.waitForFunction(
        () => document.querySelector("#source-video").currentTime > 0.4,
      );
      await click("play-button", editor);
      assert.deepEqual(
        await telemetryPanelPosition(editor),
        initial,
        "Playing video without a CSV must not paint over the telemetry panel.",
      );
      await editor.locator("#csv-input").setInputFiles(log);
      await editor.waitForFunction(() =>
        document.querySelector("#csv-drop").classList.contains("loaded"),
      );
    }
    assert.deepEqual(
      await telemetryPanelPosition(editor),
      initial,
      `${order}: loading a CSV must keep the same panel geometry.`,
    );
    assert.equal(
      Number(await editor.locator("#csv-end-anchor").inputValue()),
      1.0004,
    );
    await editor.locator("#analysis-controls > summary").click();
    await seek(2, editor);
    await click("align-end", editor);
    assert.match(
      await editor.locator("#end-alignment-status").textContent(),
      /End aligned/,
      "The default end marker must preserve sub-millisecond CSV precision.",
    );
    await editor
      .locator("#video-input")
      .setInputFiles({ ...video, name: "replacement.webm" });
    await editor.waitForFunction(
      () =>
        document.querySelector("#video-filename").textContent ===
          "replacement.webm" &&
        document.querySelector("#source-video").readyState >= 2,
    );
    assert.deepEqual(
      await telemetryPanelPosition(editor),
      initial,
      "Replacing video must not cover an existing graph.",
    );
  }
  await editor.close();
  console.log(
    "PASS: persistent telemetry panel for video-first, CSV-first, playback without CSV, and video replacement",
  );
}

async function verifyMeasurements(fixture) {
  const editor = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  editor.on("pageerror", (error) => failures.push(error.message));
  await openEditor(editor);
  const known = {
    name: "measurement.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "time_ms;thrust;pressure\n100;0;0\n200;100;2\n300;80;2\n400;0;0\n500;0;0",
    ),
  };
  await editor.locator("#csv-input").setInputFiles(known);
  await editor.waitForFunction(
    () => document.querySelector("#measure-duration").textContent === "0.289 s",
  );
  await editor
    .getByRole("tab", { name: "Measure telemetry", exact: true })
    .click();
  assert.equal(await editor.locator("#video-inspector").isVisible(), false);
  await change("measure-start", 0.15, editor);
  await change("measure-end", 0.35, editor);
  assert.equal(
    await editor.locator("#measure-duration").textContent(),
    "0.200 s",
  );
  const handle = await editor.locator("#measure-marker-end").boundingBox();
  await editor.mouse.move(handle.x + 11, handle.y + 30);
  await editor.mouse.down();
  await editor.mouse.move(handle.x + 46, handle.y + 30, { steps: 4 });
  await editor.mouse.up();
  assert.ok(Number(await editor.locator("#measure-end").inputValue()) > 0.35);
  await editor.locator("#measure-marker-start").press("ArrowRight");
  assert.equal(
    Number(await editor.locator("#measure-start").inputValue()),
    0.2,
  );
  await change("measure-start", 0.49, editor);
  assert.match(
    await editor.locator("#measurement-status").textContent(),
    /Choose A before B/,
  );
  assert.equal(
    Number(await editor.locator("#measure-start").inputValue()),
    0.2,
  );
  await editor.locator("#csv-input").setInputFiles({
    name: "missing-rise.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("time_ms;thrust;pressure\n0;100;1\n100;50;1\n200;0;0"),
  });
  await editor.waitForFunction(
    () => document.querySelector("#measure-duration").textContent === "—",
  );
  assert.equal(await editor.locator("#measure-start").inputValue(), "");
  await change("measure-start", 0, editor);
  assert.notEqual(await editor.locator("#measure-duration").textContent(), "—");
  await editor.locator("#csv-input").setInputFiles(known);
  await editor.waitForFunction(
    () => document.querySelector("#measure-duration").textContent === "0.289 s",
  );
  await change("measure-start", 0.15, editor);
  await change("measure-end", 0.35, editor);
  await editor.getByRole("tab", { name: "Sync & trim", exact: true }).click();
  await editor.locator("#video-input").setInputFiles({
    name: "local.webm",
    mimeType: "video/webm",
    buffer: fixture,
  });
  await editor.waitForFunction(() =>
    document
      .querySelector("#timing-video-detail")
      .textContent.includes("frames checked"),
  );
  await editor.locator("#analysis-controls > summary").click();
  await change("stretch-percent", 200, editor);
  const offset = await editor.locator("#sync-offset").inputValue();
  await editor
    .getByRole("tab", { name: "Measure telemetry", exact: true })
    .click();
  assert.equal(
    await editor.locator("#measure-duration").textContent(),
    "0.200 s",
  );
  assert.equal(
    await editor.locator("#measure-video-duration").textContent(),
    "0.400 s",
  );
  await click("measure-use-sync", editor);
  assert.equal(Number(await editor.locator("#csv-anchor").inputValue()), 0.15);
  assert.equal(
    Number(await editor.locator("#csv-end-anchor").inputValue()),
    0.35,
  );
  assert.equal(await editor.locator("#sync-offset").inputValue(), offset);
  assert.equal(await editor.locator("#show-measurement").isChecked(), true);
  await editor.locator("#show-measurement").uncheck();
  const before = await editor
    .locator("#preview")
    .evaluate((canvas) => canvas.toDataURL());
  await editor.locator("#show-measurement").check();
  assert.notEqual(
    await editor.locator("#preview").evaluate((canvas) => canvas.toDataURL()),
    before,
  );
  await editor.close();
  console.log(
    "PASS: CSV-only burn measurement, A/B pointer and keyboard controls, missing boundaries, original vs stretched duration, sync event reuse, optional video annotations",
  );
}

async function verifyLogUnits(fixture) {
  const editor = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  editor.on("pageerror", (error) => failures.push(error.message));
  await openEditor(editor);
  await editor.locator("#csv-settings > summary").press("Enter");
  await select("source-thrust-unit", "kgf", editor);
  await select("source-pressure-unit", "MPa", editor);
  const rows = Array.from(
    { length: 11 },
    (_, i) => `${1000000 + i * 20000};${i};${i / 10}`,
  );
  await editor.locator("#import-input").setInputFiles([
    { name: "local.webm", mimeType: "video/webm", buffer: fixture },
    {
      name: "microseconds.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "# logger\ntime_us;thrust;pressure\n\n" + rows.join("\n"),
      ),
    },
  ]);
  await editor.waitForFunction(
    () => !document.querySelector("#align-ignition").disabled,
  );
  assert.equal(await editor.locator("#summary-thrust").textContent(), "98.1 N");
  assert.equal(
    await editor.locator("#summary-pressure").textContent(),
    "10.0 bar",
  );
  await editor.locator(".sync-adjustments > summary").click();
  await change("sync-offset", 0.995, editor);
  await seek(2, editor);
  assert.equal(await editor.locator("#video-log-row").textContent(), "4 → 5");
  assert.match(
    await editor.locator("#video-log-status").textContent(),
    /Interpolated · 25.0%/,
  );
  assert.equal(
    await editor.locator("#video-log-time").textContent(),
    "1005000 µs",
  );
  await editor.getByRole("tab", { name: "Appearance", exact: true }).click();
  await select("thrust-unit", "kgf", editor);
  await select("pressure-unit", "MPa", editor);
  assert.equal(
    await editor.locator("#summary-thrust").textContent(),
    "10.0 kgf",
  );
  assert.equal(
    await editor.locator("#summary-pressure").textContent(),
    "1.0 MPa",
  );
  assert.equal(await editor.locator("#sync-offset").inputValue(), "0.995");
  assert.equal(await editor.locator("#video-log-row").textContent(), "4 → 5");
  await editor.getByRole("tab", { name: "Project", exact: true }).click();
  await select("source-thrust-unit", "N", editor);
  await editor.waitForFunction(
    () => document.querySelector("#summary-thrust").textContent === "1.02 kgf",
  );
  assert.equal(await editor.locator("#sync-offset").inputValue(), "0.995");
  assert.equal(await editor.locator("#video-log-row").textContent(), "4 → 5");
  await seek(0.5, editor);
  assert.equal(await editor.locator("#video-log-row").textContent(), "—");
  assert.equal(
    await editor.locator("#video-log-status").textContent(),
    "Before log",
  );
  await seek(3, editor);
  assert.equal(
    await editor.locator("#video-log-status").textContent(),
    "After log",
  );
  await editor.locator("#csv-input").setInputFiles({
    name: "generic-time.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("time;thrust;pressure\n0;0;0\n100000;10;1\n200000;0;0"),
  });
  await editor.waitForFunction(() =>
    document.querySelector("#notice").textContent.includes("no unit"),
  );
  await select("csv-time-unit", "us", editor);
  await editor.waitForFunction(
    () => document.querySelector("#summary-duration").textContent === "0.200 s",
  );
  assert.equal(await editor.locator("#sync-offset").inputValue(), "0.000");
  assert.match(
    await editor.locator("#csv-units-summary").textContent(),
    /Time: µs/,
  );
  await editor.close();
  console.log(
    "PASS: physical CSV rows, fractional interpolation with shifted microsecond logs, independent input/output conversions, reinterpreted source units, explicit time-unit recovery",
  );
}

async function verifyVideoClocks() {
  const editor = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  editor.on("pageerror", (error) => failures.push(error.message));
  const mediaModule = await readFile(
    new URL(
      "../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  // Serve the installed library only inside this test; no fixture enters the production build.
  await editor.route("**/__qa__/media.mjs", (route) =>
    route.fulfill({ contentType: "text/javascript", body: mediaModule }),
  );
  for (const { variable, fps } of [
    { variable: false, fps: 60 },
    { variable: false, fps: 120 },
    { variable: true, fps: 0 },
  ]) {
    await openEditor(editor);
    const fixture = Buffer.from(
      await editor.evaluate(
        async ({ variable, fps, origin }) => {
          const { Output, BufferTarget, Mp4OutputFormat, CanvasSource } =
            await import(`${origin}/__qa__/media.mjs`);
          const canvas = new OffscreenCanvas(640, 360);
          const ctx = canvas.getContext("2d");
          const target = new BufferTarget();
          const output = new Output({ target, format: new Mp4OutputFormat() });
          const source = new CanvasSource(canvas, {
            codec: "avc",
            bitrate: 600000,
          });
          output.addVideoTrack(source, variable ? {} : { frameRate: fps });
          await output.start();
          let time = 0;
          for (let i = 0; time < 3 - 1e-7; i++) {
            const duration = Math.min(
              variable ? [1 / 120, 1 / 30, 1 / 60][i % 3] : 1 / fps,
              3 - time,
            );
            ctx.fillStyle = "#283c32";
            ctx.fillRect(0, 0, 640, 360);
            ctx.fillStyle = "#ffb16e";
            ctx.fillRect((time / 3) * 600, 100, 35, 100);
            ctx.font = "24px monospace";
            ctx.fillText(
              `${time.toFixed(6)} s / synthetic timing fixture`,
              20,
              40,
            );
            await source.add(time, duration);
            time += duration;
          }
          source.close();
          await output.finalize();
          return Array.from(new Uint8Array(target.buffer));
        },
        { variable, fps, origin },
      ),
    );
    const log = Buffer.from(
      [
        "time_ms;thrust;pressure",
        ...Array.from(
          { length: 151 },
          (_, i) => `${i * 20};${i * 2};${i * 0.1}`,
        ),
      ].join("\n"),
    );
    await editor.locator("#import-input").setInputFiles([
      { name: "timestamp-fixture.mp4", mimeType: "video/mp4", buffer: fixture },
      { name: "50-hz.csv", mimeType: "text/csv", buffer: log },
    ]);
    await editor.waitForFunction(
      () =>
        document
          .querySelector("#timing-video-detail")
          .textContent.includes("frames checked") &&
        !document.querySelector("#align-ignition").disabled,
    );
    assert.match(
      await editor.locator("#timing-log-rate").textContent(),
      /50\.0 Hz/,
    );
    assert.equal(
      /VFR/.test(await editor.locator("#timing-video-rate").textContent()),
      variable,
    );
    if (!variable)
      assert.match(
        await editor.locator("#timing-video-rate").textContent(),
        new RegExp(`^${fps} fps`),
      );
    assert.equal(
      await editor.locator("#stretch-percent").inputValue(),
      "100.000",
    );
    await seek(1, editor);
    await click("frame-next", editor);
    await editor.waitForFunction(
      () => !document.querySelector("#source-video").seeking,
    );
    const sourceInput = new Input({
      source: new BufferSource(new Uint8Array(fixture)),
      formats: ALL_FORMATS,
    });
    const sourceTrack = await sourceInput.getPrimaryVideoTrack();
    const sourceTimes = [];
    for await (const packet of new EncodedPacketSink(sourceTrack).packets(
      undefined,
      undefined,
      { metadataOnly: true },
    ))
      sourceTimes.push(packet.timestamp);
    sourceTimes.sort((a, b) => a - b);
    const nextTime = sourceTimes.find((t) => t > 1 + 1e-7);
    const actualTime = await editor
      .locator("#source-video")
      .evaluate((v) => v.currentTime);
    assert.ok(
      Math.abs(actualTime - nextTime) < 0.0001,
      `Frame stepping must use real timestamps: ${actualTime} vs ${nextTime}`,
    );
    const shownTime = Number(
      (await editor.locator("#video-frame-time").textContent()).replace(
        " s",
        "",
      ),
    );
    const frameIndex = sourceTimes.findIndex(
      (t) => Math.abs(t - shownTime) < 0.000002,
    );
    assert.equal(
      Number(await editor.locator("#video-frame-number").textContent()),
      frameIndex + 1,
    );
    await click("frame-set-in", editor);
    await click("frame-set-out", editor);
    await editor.waitForFunction(() =>
      document
        .querySelector("#video-selected-frames")
        .textContent.endsWith("· 1 frame"),
    );
    sourceInput.dispose();
    if (fps === 60) {
      await editor.locator("#analysis-controls > summary").press("Enter");
      await editor.locator("#two-point-controls > summary").press("Enter");
      await change("point-a-csv", 0.5, editor);
      await change("point-a-video", 0.5, editor);
      await change("point-b-csv", 1.5, editor);
      await change("point-b-video", 2.5, editor);
      assert.equal(
        await editor.locator("#clock-csv-interval").textContent(),
        "1.000 s",
      );
      assert.equal(
        await editor.locator("#clock-video-interval").textContent(),
        "2.000 s",
      );
      assert.equal(
        await editor.locator("#clock-required-scale").textContent(),
        "200.000%",
      );
      assert.equal(
        await editor.locator("#stretch-percent").inputValue(),
        "100.000",
      );
      await click("fit-events", editor);
      assert.equal(
        await editor.locator("#stretch-percent").inputValue(),
        "200.000",
      );
      await seek(1.5, editor);
      assert.equal(
        await editor.locator("#csv-time-readout").textContent(),
        "CSV 1.000 s",
      );
      assert.equal(
        await editor.locator("#source-video").evaluate((v) => v.playbackRate),
        1,
      );
      await click("reset-timeline", editor);
    }
    await change("trim-start", 0.5, editor);
    await change("trim-end", 2.5, editor);
    await editor.getByRole("tab", { name: "Export", exact: true }).click();
    await select("export-resolution", "1280", editor);
    for (const rate of variable ? [0, 30] : [0]) {
      await select("export-fps", String(rate), editor);
      const event = editor.waitForEvent("download", { timeout: 60000 });
      await click("export-button", editor);
      const download = await event;
      const path = `${outputDir}/clock-${variable ? "vfr" : `${fps}fps`}-${rate}.mp4`;
      await download.saveAs(path);
      await editor.waitForFunction(
        () => !document.querySelector("#export-dialog").open,
      );
      const input = new Input({
        source: new BufferSource(new Uint8Array(await readFile(path))),
        formats: ALL_FORMATS,
      });
      const track = await input.getPrimaryVideoTrack();
      const times = [];
      for await (const packet of new EncodedPacketSink(track).packets(
        undefined,
        undefined,
        { metadataOnly: true },
      ))
        times.push(packet.timestamp);
      times.sort((a, b) => a - b);
      assert.ok(Math.abs((await track.computeDuration()) - 2) < 0.01);
      if (!rate) {
        const expected = sourceTimes
          .filter((t) => t >= 0.5 - 1e-6 && t < 2.5 - 1e-6)
          .map((t) => t - 0.5);
        // A frame spanning the trim boundary is retained with a clamped start.
        if (!expected.length || expected[0] > 0.0001) expected.unshift(0);
        assert.equal(times.length, expected.length);
        assert.ok(times.every((t, i) => Math.abs(t - expected[i]) < 0.001));
      } else assert.equal(times.length, 60);
      if (!variable && !rate) assert.equal(times.length, fps * 2);
      input.dispose();
      for (const outputTime of [0.5, 1.5]) {
        await seek(0.5 + outputTime, editor);
        const csvTime = Number(
          (await editor.locator("#csv-time-readout").textContent()).match(
            /CSV ([\d.]+)/,
          )[1],
        );
        assert.ok(
          Math.abs(csvTime - (outputTime + 0.5)) <=
            (variable ? 0.034 : 1 / fps + 0.001),
          "Preview must use the presented frame timestamp, within one source frame of a seek.",
        );
        const regions = await compositionRegions(editor);
        const error = await editor.evaluate(async ({ time, region }) => {
          const reference = document.querySelector("#preview");
          const expected = reference
            .getContext("2d")
            .getImageData(region.x, region.y, region.width, region.height).data;
          const video = document.createElement("video");
          video.muted = true;
          video.src = document.querySelector("#download-again").href;
          await new Promise((resolve, reject) => {
            video.onloadeddata = resolve;
            video.onerror = reject;
          });
          await new Promise((resolve) => {
            video.onseeked = resolve;
            video.currentTime = time;
          });
          const canvas = document.createElement("canvas");
          canvas.width = reference.width;
          canvas.height = reference.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const pixels = ctx.getImageData(region.x, region.y, region.width, region.height).data;
          let sum = 0,
            count = 0;
          for (let i = 0; i < pixels.length; i += 16) {
            sum += Math.abs(pixels[i] - expected[i]);
            count++;
          }
          video.removeAttribute("src");
          video.load();
          return sum / count;
        }, { time: outputTime, region: regions.panel });
        assert.ok(
          error < 12,
          `Telemetry must follow seconds at ${variable ? "VFR" : `${fps} FPS`}, export rate ${rate}: ${error}`,
        );
      }
    }
  }
  await editor.close();
  console.log(
    "PASS: batch import; full 60/120 FPS/VFR inspection; 200% clock correction from two events; exact frame stepping; 50 Hz CSV without drift; trimmed export timestamps and 30 FPS conversion without duration changes",
  );
}

try {
  await openEditor(page);
  await page
    .getByRole("heading", { name: "Video & telemetry editor" })
    .waitFor();
  await page.screenshot({
    path: `${outputDir}/desktop-empty.png`,
    fullPage: true,
  });
  assert.equal(await page.locator("#export-button").isEnabled(), false);
  await page.locator("#csv-input").setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("time_ms;thrust;pressure\n0;1;1\n0;2;2"),
  });
  await page.waitForFunction(() =>
    document.querySelector("#notice").textContent.includes("increase strictly"),
  );
  assert.equal(
    await page
      .locator("#csv-drop")
      .evaluate((el) => el.classList.contains("loaded")),
    false,
  );

  await page.getByRole("button", { name: "Load demo" }).click();
  await page.waitForFunction(
    () => !document.querySelector("#align-ignition").disabled,
    undefined,
    { timeout: 60000 },
  );
  await page.waitForFunction(
    () => !document.querySelector("#source-video").seeking,
  );
  await page.waitForFunction(() =>
    document
      .querySelector("#timing-video-detail")
      .textContent.includes("frames checked"),
  );
  assert.equal(await page.locator("#summary-samples").textContent(), "331");
  console.log("PASS: import, invalid CSV, synthetic video and audio");

  // Reuse the generated local source through a download, respecting connect-src.
  const sourceDownload = page.waitForEvent("download");
  await page.locator("#source-video").evaluate((video) => {
    const link = document.createElement("a");
    link.href = video.currentSrc || video.src;
    link.download = "source-fixture.webm";
    link.click();
  });
  await (await sourceDownload).saveAs(`${outputDir}/source-fixture.webm`);
  const fixture = await readFile(`${outputDir}/source-fixture.webm`);
  const stepping = await verifyFrameStepping({ browser, baseURL, outputDir });
  failures.push(...stepping.failures);
  requests.push(...stepping.requests);
  const workflow = await verifyEditorWorkflow({
    browser,
    baseURL,
    fixture,
    outputDir,
  });
  failures.push(...workflow.failures);
  requests.push(...workflow.requests);
  const profiles = await verifyProfiles({ browser, baseURL, fixture, outputDir });
  failures.push(...profiles.failures);
  requests.push(...profiles.requests);
  const series = await verifySeries({ browser, baseURL, outputDir });
  failures.push(...series.failures);
  requests.push(...series.requests);
  const theory = await verifyTheory({ browser, baseURL, outputDir });
  failures.push(...theory.failures);
  requests.push(...theory.requests);
  const templates = await verifyTemplates({ browser, baseURL, outputDir });
  failures.push(...templates.failures);
  requests.push(...templates.requests);
  await verifyDefaultFullHD(fixture);
  await verifyLocalization(fixture);
  await verifyIgnitionAlignment(fixture);
  await verifyPlayheadGeometry(page);
  await verifyImportOrder(fixture);
  await verifyMeasurements(fixture);
  await verifyLogUnits(fixture);
  await verifyVideoClocks();

  await seek(2);
  const pausedImage = await page
    .locator("#preview")
    .evaluate((canvas) => canvas.toDataURL());
  await click("play-button");
  await page.waitForFunction(
    () => document.querySelector("#source-video").currentTime > 2.5,
  );
  await click("play-button");
  assert.notEqual(
    await page.locator("#preview").evaluate((canvas) => canvas.toDataURL()),
    pausedImage,
  );
  console.log("PASS: continuously updating live video and telemetry playback");

  await page.locator(".sync-adjustments > summary").click();
  await change("trim-start", 1);
  await change("trim-end", 4);
  await seek(2);
  const anchor = Number(await page.locator("#csv-anchor").inputValue());
  await click("align-ignition");
  const offset = Number(await page.locator("#sync-offset").inputValue());
  assert.ok(Math.abs(offset - (2 - anchor)) < 0.001);
  await click("offset-plus");
  assert.ok(
    Math.abs(
      Number(await page.locator("#sync-offset").inputValue()) - offset - 0.01,
    ) < 0.001,
  );
  await change("sync-offset", -0.25);
  assert.equal(await page.locator("#sync-offset").inputValue(), "-0.250");
  const csvBox = await page.locator("#csv-track").boundingBox();
  await page.mouse.move(
    csvBox.x + csvBox.width / 2,
    csvBox.y + csvBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    csvBox.x + csvBox.width / 2 + 25,
    csvBox.y + csvBox.height / 2,
    { steps: 4 },
  );
  await page.mouse.up();
  assert.ok(Number(await page.locator("#sync-offset").inputValue()) > -0.25);
  await change("sync-offset", -0.25);
  const handle = await page.locator("#trim-handle-start").boundingBox();
  await page.mouse.move(handle.x + 3, handle.y + 10);
  await page.mouse.down();
  await page.mouse.move(handle.x + 23, handle.y + 10, { steps: 4 });
  await page.mouse.up();
  assert.ok(Number(await page.locator("#trim-start").inputValue()) > 1);
  await change("trim-start", 1);
  await seek(3);
  const previousOffset = await page.locator("#sync-offset").inputValue();
  await page.evaluate(() => {
    const video = document.querySelector("#source-video");
    window.__qaJumpEvents = [];
    const record = (event) => {
      window.__qaJumpEvents.push({ event: event.type, time: video.currentTime,
        paused: video.paused, seeking: video.seeking, ended: video.ended });
      if (window.__qaJumpEvents.length > 80) window.__qaJumpEvents.shift();
    };
    const events = ["play", "playing", "pause", "seeking", "seeked", "ended", "timeupdate"];
    for (const event of events)
      video.addEventListener(event, record);
    window.__qaStopJumpRecording = () => {
      for (const event of events) video.removeEventListener(event, record);
      delete window.__qaStopJumpRecording;
    };
  });
  await click("play-button");
  await click("jump-start");
  try {
    await page.waitForFunction(() => {
      const video = document.querySelector("#source-video");
      return !video.seeking && video.paused && Math.abs(video.currentTime - 1) < 0.001;
    });
  } catch (error) {
    const state = await page.evaluate(() => {
      const video = document.querySelector("#source-video");
      return { currentTime: video.currentTime, paused: video.paused,
        seeking: video.seeking, ended: video.ended, playbackRate: video.playbackRate,
        fields: Object.fromEntries(["trim-start", "trim-end", "sync-offset", "playback-rate"]
          .map((id) => [id, document.getElementById(id).value])),
        labels: Object.fromEntries(["scrubber-time", "current-time", "video-frame-number", "notice"]
          .map((id) => [id, document.getElementById(id).textContent])),
        events: window.__qaJumpEvents };
    });
    console.error("Selected-start transport failure:", JSON.stringify(state));
    await writeFile(join(outputDir, "jump-start-failure.json"), JSON.stringify(state, null, 2));
    await page.screenshot({ path: join(outputDir, "jump-start-failure.png"), fullPage: true });
    throw error;
  } finally {
    await page.evaluate(() => window.__qaStopJumpRecording?.());
  }
  assert.equal(await page.locator("#sync-offset").inputValue(), previousOffset);
  assert.equal(await page.locator("#trim-end").inputValue(), "4.000");
  await seek(2);
  await page.locator("#jump-start").press("Home");
  await page.waitForFunction(
    () =>
      !document.querySelector("#source-video").seeking &&
      Math.abs(document.querySelector("#source-video").currentTime - 1) < 0.001,
  );
  console.log(
    "PASS: return to trimmed start while playing, Home shortcut, synchronization and trim preserved",
  );
  console.log(
    "PASS: trim controls, pointer handles, ignition alignment, negative offset, CSV dragging",
  );

  // Stretching is optional and keeps original logger measurements intact.
  await page.locator("#analysis-controls > summary").click();
  await change("sync-offset", -0.25);
  const csvAnchor = Number(await page.locator("#csv-anchor").inputValue());
  const anchorVideo = -0.25 + csvAnchor;
  await change("stretch-percent", 150);
  assert.ok(
    Math.abs(
      Number(await page.locator("#sync-offset").inputValue()) +
        csvAnchor * 1.5 -
        anchorVideo,
    ) < 0.001,
  );
  await change("stretch-percent", 0);
  assert.equal(await page.locator("#stretch-percent").inputValue(), "150.000");
  await click("reset-stretch");
  assert.equal(await page.locator("#stretch-percent").inputValue(), "100.000");
  const stretchHandle = await page.locator("#stretch-handle").boundingBox();
  const initialLeft = await page
    .locator("#csv-track")
    .evaluate((el) => el.style.left);
  await page.mouse.move(stretchHandle.x + 10, stretchHandle.y + 15);
  await page.mouse.down();
  await page.mouse.move(stretchHandle.x - 30, stretchHandle.y + 15, {
    steps: 4,
  });
  await page.mouse.up();
  assert.ok(Number(await page.locator("#stretch-percent").inputValue()) < 100);
  assert.equal(
    await page.locator("#csv-track").evaluate((el) => el.style.left),
    initialLeft,
  );
  await page.locator("#two-point-controls > summary").click();
  await change("point-a-csv", 0.5);
  await seek(1);
  await click("capture-a");
  await change("point-b-csv", 2.5);
  await seek(4);
  await click("capture-b");
  await click("fit-events");
  assert.equal(await page.locator("#stretch-percent").inputValue(), "150.000");
  assert.equal(await page.locator("#sync-offset").inputValue(), "0.250");
  await seek(2);
  assert.match(await page.locator("#csv-time-readout").textContent(), /1\.167/);
  // Mark only the end after aligning the start, including a log with a tail.
  const alignedStart = await page.locator("#aligned-start-time").textContent();
  assert.equal(Number(await page.locator("#csv-end-anchor").inputValue()), 5.5);
  await click("reset-stretch");
  await change("csv-end-anchor", 2.5);
  await seek(4);
  await click("align-end");
  assert.equal(await page.locator("#stretch-percent").inputValue(), "150.000");
  assert.equal(await page.locator("#sync-offset").inputValue(), "0.250");
  assert.equal(
    await page.locator("#aligned-start-time").textContent(),
    alignedStart,
  );
  assert.match(
    await page.locator("#end-alignment-status").textContent(),
    /End aligned/,
  );
  await change("csv-end-anchor", 0.1);
  await click("align-end");
  assert.match(
    await page.locator("#end-alignment-status").textContent(),
    /later/,
  );
  assert.equal(await page.locator("#stretch-percent").inputValue(), "150.000");
  await change("csv-end-anchor", 99);
  assert.equal(await page.locator("#align-end").isEnabled(), false);
  assert.equal(
    await page.locator("#csv-end-anchor").getAttribute("aria-invalid"),
    "true",
  );
  assert.equal(await page.locator("#csv-end-anchor").inputValue(), "99");
  assert.match(
    await page.locator("#end-alignment-status").textContent(),
    /within the CSV/,
  );
  await change("csv-end-anchor", 2.5);
  await seek(0.5);
  await click("align-end");
  assert.match(
    await page.locator("#end-alignment-status").textContent(),
    /later/,
  );
  assert.equal(await page.locator("#sync-offset").inputValue(), "0.250");
  await click("jump-alignment");
  const ignitionTime = 0.25 + csvAnchor * 1.5;
  await page.waitForFunction(
    (time) =>
      !document.querySelector("#source-video").seeking &&
      Math.abs(document.querySelector("#source-video").currentTime - time) <
        0.001,
    ignitionTime,
  );
  console.log(
    "PASS: align end calculates duration with ignition fixed; custom end before CSV tail; invalid ends leave mapping unchanged; jump to shifted ignition",
  );
  await seek(2);
  await change("point-b-csv", 0.5);
  await click("fit-events");
  assert.match(await page.locator("#fit-status").textContent(), /later/);
  assert.equal(await page.locator("#stretch-percent").inputValue(), "150.000");
  await page.locator("#analysis-controls > summary").click();
  await page.locator("#stretch-handle").waitFor({ state: "hidden" });
  console.log(
    "PASS: optional stretching, pivot preservation, right-edge drag, two-event capture/fit, invalid mapping rejection, original CSV clock",
  );

  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await page
    .getByRole("button", { name: "About side panel values", exact: true })
    .click();
  assert.equal(await page.locator("#info-tooltip").isVisible(), true);
  await page
    .getByRole("button", { name: "About side panel values", exact: true })
    .press("Escape");
  assert.equal(await page.locator("#info-tooltip").isVisible(), false);
  await page.locator("#test-title").fill("FLAMESYNC / INTEGRATION TEST");
  await page.getByRole("tab", { name: "Project", exact: true }).click();
  await page.locator("#meta-motor").fill("DEMO MOTOR / REV. 2");
  await page.locator("#meta-testDate").fill("2026-10-16");
  await page.locator("#more-test-details > summary").click();
  await page.locator("#meta-testId").fill("DEMO-004");
  await page.locator("#meta-logger").fill("Synthetic telemetry generator");
  await page.locator("#meta-camera").fill("Browser canvas / 24 fps");
  await page
    .locator("#meta-notes")
    .fill("Demonstration only. No real engine data.");
  await seek(2);
  const liveTotals = await page
    .locator("#preview")
    .evaluate((canvas) => canvas.toDataURL());
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await select("summary-mode", "final");
  assert.notEqual(
    await page.locator("#preview").evaluate((canvas) => canvas.toDataURL()),
    liveTotals,
  );
  await select("summary-mode", "live");
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await page.locator('[data-theme="light"]').click();
  assert.equal(
    await page.locator('[data-theme="light"]').getAttribute("aria-pressed"),
    "true",
  );
  await select("thrust-unit", "kgf");
  await select("pressure-unit", "MPa");
  await seek(2);
  await page
    .getByRole("tab", { name: "Measure telemetry", exact: true })
    .click();
  await page.locator("#show-measurement").check();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `${outputDir}/desktop-studio.png`,
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await select("export-resolution", "1280");
  const regions = await compositionRegions(page);
  const previewPixels = await regionPixels(page, regions.panel);
  assert.ok(regions.details, "The source record must be included in export checks.");
  const detailsPixels = await regionPixels(page, regions.details);

  for (const format of ["mp4", "webm"]) {
    await select("export-format", format);
    const downloadEvent = page.waitForEvent("download", { timeout: 60000 });
    await click("export-button");
    const download = await downloadEvent;
    const path = `${outputDir}/export.${format}`;
    await download.saveAs(path);
    await page.waitForFunction(
      () => !document.querySelector("#export-dialog").open,
    );
    const buffer = new Uint8Array(await readFile(path));
    const input = new Input({
      source: new BufferSource(buffer),
      formats: ALL_FORMATS,
    });
    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      assert.ok(videoTrack);
      assert.ok(
        await input.getPrimaryAudioTrack(),
        "Audio must be present in the exported file.",
      );
      assert.equal(await videoTrack.getDisplayWidth(), 1280);
      assert.equal(await videoTrack.getDisplayHeight(), 720);
      const duration = await input.computeDuration();
      assert.ok(
        duration >= 3 && duration < 3.12,
        `Unexpected export duration: ${duration}`,
      );
    } finally {
      input.dispose();
    }

    const difference = await page.evaluate(async (preview) => {
      const video = document.createElement("video");
      video.muted = true;
      video.src = document.querySelector("#download-again").href;
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = reject;
      });
      await new Promise((resolve) => {
        video.onseeked = resolve;
        video.currentTime = 1;
      });
      const canvas = document.createElement("canvas");
      canvas.width = preview.width;
      canvas.height = preview.height;
      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(
        preview.region.x,
        preview.region.y,
        preview.region.width,
        preview.region.height,
      ).data;
      let error = 0;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 16) {
        error += Math.abs(pixels[i] - preview.values[i]);
        count++;
      }
      video.removeAttribute("src");
      video.load();
      return error / count;
    }, previewPixels);
    assert.ok(
      difference < 12,
      `${format} overlay diverges from preview after trimming: ${difference}`,
    );
    const metadataDifference = await page.evaluate(async (reference) => {
      const video = document.createElement("video");
      video.muted = true;
      video.src = document.querySelector("#download-again").href;
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = reject;
      });
      await new Promise((resolve) => {
        video.onseeked = resolve;
        video.currentTime = 1;
      });
      const canvas = document.createElement("canvas");
      canvas.width = reference.width;
      canvas.height = reference.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(
        reference.region.x,
        reference.region.y,
        reference.region.width,
        reference.region.height,
      ).data;
      let error = 0,
        count = 0;
      for (let i = 0; i < pixels.length; i += 16) {
        error += Math.abs(pixels[i] - reference.values[i]);
        count++;
      }
      video.removeAttribute("src");
      video.load();
      return error / count;
    }, detailsPixels);
    assert.ok(
      metadataDifference < 12,
      `Exported test details differ from preview: ${metadataDifference}`,
    );
    console.log(
      `PASS: ${format.toUpperCase()} export, trimmed duration, audio, resolution, preview parity (mean pixel error ${difference.toFixed(2)})`,
    );
  }

  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await select("frame-aspect", "square");
  assert.deepEqual(
    await page.locator("#preview").evaluate((c) => [c.width, c.height]),
    [1920, 1920],
  );
  await select("presentation-layout", "overlay");
  assert.equal(await page.locator("#details-layout-note").isVisible(), true);
  assert.equal(await page.locator("#opacity-setting").isVisible(), true);
  await select("presentation-layout", "full");
  await select("frame-aspect", "source");
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  console.log(
    "PASS: full-frame presentation, live/final totals, test metadata in exports, output aspect selection",
  );

  await click("export-button");
  await click("cancel-export");
  assert.equal(
    await page.locator("#export-dialog").evaluate((dialog) => dialog.open),
    false,
  );
  assert.equal(await page.locator("#export-button").isEnabled(), true);
  console.log("PASS: export cancellation");

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    deviceScaleFactor: 1,
  });
  mobile.on("pageerror", (error) => failures.push(error.message));
  await openEditor(mobile);
  await mobile.screenshot({
    path: `${outputDir}/mobile-studio.png`,
    fullPage: true,
  });
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await click("help-open", mobile);
  assert.equal(
    await mobile.locator("#help-dialog").evaluate((dialog) => dialog.open),
    true,
  );
  await click("help-close", mobile);
  await mobile.getByRole("tab", { name: "Appearance", exact: true }).click();
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await mobile.locator("#import-input").setInputFiles([
    { name: "mobile-local.webm", mimeType: "video/webm", buffer: fixture },
    {
      name: "mobile.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("time_ms;thrust;pressure\n0;0;0\n100;100;2\n200;0;0"),
    },
  ]);
  await mobile.waitForFunction(
    () =>
      !document.querySelector("#frame-set-in").disabled &&
      !document.querySelector("#measure-start").disabled,
  );
  await mobile
    .getByRole("tab", { name: "Measure telemetry", exact: true })
    .click();
  assert.equal(await mobile.locator("#video-inspector").isVisible(), true);
  assert.equal(
    await mobile.locator("#measure-duration").textContent(),
    "0.190 s",
  );
  await mobile
    .getByRole("button", { name: "About source frames", exact: true })
    .click();
  assert.equal(await mobile.locator("#info-tooltip").isVisible(), true);
  const tooltipBox = await mobile.locator("#info-tooltip").boundingBox();
  assert.ok(tooltipBox.x >= 0 && tooltipBox.x + tooltipBox.width <= 390);
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "Loaded video inspector and measurement controls must fit the mobile viewport.",
  );
  await mobile
    .getByRole("button", { name: "About source frames", exact: true })
    .press("Escape");
  await mobile.evaluate(() => window.scrollTo(0, 0));
  await mobile.screenshot({
    path: `${outputDir}/mobile-loaded.png`,
    fullPage: true,
  });
  assert.deepEqual(failures, [], "Browser errors must be resolved.");
  assert.deepEqual(
    requests.filter(
      (r) =>
        /^https?:/.test(r.url) &&
        (new URL(r.url).origin !== origin || r.method !== "GET"),
    ),
    [],
    "Media processing must not make upload or third-party network requests.",
  );
  console.log(
    "PASS: mobile layout, guide dialog, clean browser console, no uploads or third-party requests",
  );
} finally {
  await browser.close();
  if (!process.env.TEST_RESULTS_DIR)
    await rm(outputDir, { recursive: true, force: true });
}
