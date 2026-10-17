import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Exercise the editor through public controls with media kept in memory. */
export async function verifyEditorWorkflow({
  browser,
  baseURL,
  fixture,
  outputDir,
}) {
  const failures = [];
  const requests = [];
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    locale: "en-US",
  });
  // Observe only the current composed frame; no app-only test hooks or growing
  // playback history are needed to verify source names reach the video output.
  await page.addInitScript(() => {
    window.__qaPreviewTexts = [];
    window.__qaPreviewItems = [];
    window.__qaVideoRect = null;
    const originalFill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
      if (
        this.canvas.id === "preview" &&
        x === 0 &&
        y === 0 &&
        width === this.canvas.width &&
        height === this.canvas.height &&
        this.getTransform().isIdentity
      ) {
        window.__qaPreviewTexts = [];
        window.__qaPreviewItems = [];
        window.__qaVideoRect = null;
      }
      return originalFill.call(this, x, y, width, height);
    };
    const originalText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (this.canvas.id === "preview") {
        window.__qaPreviewTexts.push(String(args[0]));
        if (window.__qaPreviewTexts.length > 256)
          window.__qaPreviewTexts.shift();
        const metrics = this.measureText(String(args[0]));
        const width = Math.min(metrics.width, args[3] ?? Infinity);
        const left =
          this.textAlign === "right" || this.textAlign === "end"
            ? args[1] - width
            : this.textAlign === "center"
              ? args[1] - width / 2
              : args[1];
        const transform = this.getTransform();
        const top = transform.transformPoint({
          x: left,
          y: args[2] - metrics.actualBoundingBoxAscent,
        });
        const bottom = transform.transformPoint({
          x: left + width,
          y: args[2] + metrics.actualBoundingBoxDescent,
        });
        window.__qaPreviewItems.push({
          text: String(args[0]),
          left: top.x,
          top: top.y,
          right: bottom.x,
          bottom: bottom.y,
        });
      }
      return originalText.apply(this, args);
    };
    const originalImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (
        this.canvas.id === "preview" &&
        args[0] instanceof HTMLVideoElement &&
        args.length === 5
      ) {
        const transform = this.getTransform();
        const point = transform.transformPoint({ x: args[1], y: args[2] });
        window.__qaVideoRect = {
          x: point.x,
          y: point.y,
          width: args[3] * transform.a,
          height: args[4] * transform.d,
        };
      }
      return originalImage.apply(this, args);
    };
  });
  page.on("pageerror", (error) =>
    failures.push(`Editor workflow: ${error.message}`),
  );
  page.on("console", (entry) => {
    if (entry.type() === "error")
      failures.push(`Editor workflow: ${entry.text()}`);
  });
  page.on("request", (request) =>
    requests.push({ url: request.url(), method: request.method() }),
  );
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const log = Buffer.from(
    [
      "time_ms;thrust;pressure",
      ...Array.from(
        { length: 331 },
        (_, i) =>
          `${i * 20};${i < 25 || i > 290 ? 0 : 100 + (i % 20)};${i < 25 || i > 290 ? 0 : 2}`,
      ),
    ].join("\n"),
  );
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const click = async (id) => {
    await page.locator(`#${id}`).click();
    await settle();
  };
  const change = async (id, value) => {
    await page.locator(`#${id}`).fill(String(value));
    await page.locator(`#${id}`).press("Tab");
    await settle();
  };
  const snapshot = () =>
    page.evaluate(() =>
      Object.fromEntries(
        ["trim-start", "trim-end", "sync-offset", "stretch-percent"].map(
          (id) => [id, Number(document.getElementById(id).value)],
        ),
      ),
    );
  const viewport = () =>
    page.locator("#scrubber").evaluate((input) => ({
      start: Number(input.min),
      end: Number(input.max),
      value: Number(input.value),
    }));
  const seek = async (time) => {
    await page.locator("#scrubber").evaluate((input, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, time);
    await page.waitForFunction((value) => {
      const video = document.querySelector("#source-video");
      return !video.seeking && Math.abs(video.currentTime - value) < 0.002;
    }, time);
    await settle();
  };
  const open = async (video = fixture, filename = "workflow-local.webm") => {
    await page.goto(baseURL);
    await page.locator("#language-select").selectOption("en");
    await page.locator("#import-input").setInputFiles([
      {
        name: filename,
        mimeType: filename.endsWith(".mp4") ? "video/mp4" : "video/webm",
        buffer: video,
      },
      { name: "workflow-local.csv", mimeType: "text/csv", buffer: log },
    ]);
    await page.waitForFunction(
      () =>
        document
          .querySelector("#timing-video-detail")
          .textContent.includes("frames checked") &&
        !document.querySelector("#frame-next").disabled,
    );
    await page.locator(".sync-adjustments").evaluate((element) => {
      element.open = true;
    });
    await page.locator("#analysis-controls").evaluate((element) => {
      element.open = true;
    });
    await settle();
  };
  const caseOf = async (name, run) => {
    try {
      await run();
      console.log(`PASS: ${name}`);
    } catch (error) {
      failures.push(
        `${name}: ${error.stack || error.message || String(error)}`,
      );
    }
  };
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  const undo = async (keyboard = false) => {
    if (keyboard) {
      await blur();
      await page.keyboard.press(`${modifier}+z`);
      await settle();
    } else await click("timeline-undo");
  };
  const redo = async (keyboard = false) => {
    if (keyboard) {
      await blur();
      await page.keyboard.press(`${modifier}+Shift+z`);
      await settle();
    } else await click("timeline-redo");
  };
  const drag = async (id, dx, { cancel = "", alt = false } = {}) => {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    const box = await page.locator(`#${id}`).boundingBox();
    assert.ok(box?.width && box?.height, `${id} must have an operable target`);
    const x = box.x + Math.min(box.width / 2, 10);
    const y = box.y + box.height / 2;
    if (alt) await page.keyboard.down("Alt");
    try {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y, { steps: 12 });
      await settle();
      if (cancel === "pointercancel")
        await page.locator(`#${id}`).evaluate((element) =>
          element.dispatchEvent(
            new PointerEvent("pointercancel", {
              bubbles: true,
              pointerId: 1,
              pointerType: "mouse",
              button: 0,
            }),
          ),
        );
      if (cancel === "Escape") await page.keyboard.press("Escape");
      await page.mouse.up();
    } finally {
      if (alt) await page.keyboard.up("Alt");
    }
    await settle();
  };
  try {
    await caseOf(
      "video and CSV filenames in the composed source record",
      async () => {
        await open();
        const expectNames = async (videoName, logName) => {
          await page.waitForFunction(
            ([video, log]) =>
              window.__qaPreviewTexts.includes(video) &&
              window.__qaPreviewTexts.includes(log),
            [videoName, logName],
          );
          const texts = await page.evaluate(() => window.__qaPreviewTexts);
          assert.equal(texts.filter((text) => text === videoName).length, 1);
          assert.equal(texts.filter((text) => text === logName).length, 1);
        };
        await expectNames("workflow-local.webm", "workflow-local.csv");
        await page.locator("#video-input").setInputFiles({
          name: "replacement-video.webm",
          mimeType: "video/webm",
          buffer: fixture,
        });
        await expectNames("replacement-video.webm", "workflow-local.csv");
        assert.ok(
          !(await page.evaluate(() => window.__qaPreviewTexts)).includes(
            "workflow-local.webm",
          ),
        );
        await page.locator("#csv-input").setInputFiles({
          name: "replacement-log.csv",
          mimeType: "text/csv",
          buffer: log,
        });
        await expectNames("replacement-video.webm", "replacement-log.csv");
        assert.ok(
          !(await page.evaluate(() => window.__qaPreviewTexts)).includes(
            "workflow-local.csv",
          ),
        );

        const videoName = `Відео-${"довга_назва_джерела_".repeat(12)}.webm`;
        const logName = `Лог-${"довга_назва_телеметрії_".repeat(12)}.csv`;
        await page.locator("#import-input").setInputFiles([
          { name: videoName, mimeType: "video/webm", buffer: fixture },
          { name: logName, mimeType: "text/csv", buffer: log },
        ]);
        await page.waitForFunction(() => {
          const texts = window.__qaPreviewTexts;
          const video = texts.indexOf("VIDEO");
          const log = texts.indexOf("LOG", video + 1);
          if (video < 0 || log <= video) return false;
          const videoName = texts.slice(video + 1, log).join("");
          const logName = texts.slice(log + 1).join("");
          return (
            videoName.includes("Відео-") &&
            videoName.includes(".webm") &&
            logName.includes("Лог-") &&
            logName.includes(".csv")
          );
        });
        await page.locator("#preview-workspace").screenshot({
          path: join(outputDir, "video-overlay-long-filenames.png"),
        });
      },
    );
    await caseOf(
      "FullHD composition keeps footage fixed and every populated record visible",
      async () => {
        await open();
        assert.equal(await page.locator("#frame-aspect").inputValue(), "landscape");
        assert.equal(await page.locator("#export-resolution").inputValue(), "1920");
        assert.deepEqual(
          await page.locator("#preview").evaluate((canvas) => [canvas.width, canvas.height]),
          [1920, 1080],
        );
        const baseline = await page.evaluate(() => window.__qaVideoRect);
        assert.ok(baseline?.width && baseline?.height);
        await page.locator("#more-test-details").evaluate((element) => {
          element.open = true;
        });
        const fields = {
          testId: "TEST ID",
          location: "LOCATION",
          logger: "LOGGER",
          sampleRate: "LOG RATE",
          camera: "CAMERA",
          notes: "NOTES",
        };
        await page.locator("#meta-motor").fill("MD68 / DEVELOPMENT TEST");
        await page.locator("#meta-testDate").fill("2026-10-17");
        for (const key of Object.keys(fields)) {
          const input = page.locator(`#meta-${key}`);
          const maximum = await input.evaluate((element) => element.maxLength);
          const value = `${key}: Калібровані датчики / Test record `.repeat(20);
          await input.fill(value.slice(0, maximum > 0 ? maximum : 100));
        }
        await settle();
        assert.deepEqual(
          await page.evaluate(() => window.__qaVideoRect),
          baseline,
          "Filling metadata must not reduce the footage",
        );
        await click("tab-overlay");
        for (const showDetails of [true, false]) {
          for (const showPressure of [true, false]) {
            for (const showImpulse of [true, false]) {
              await page.locator("#show-details").setChecked(showDetails);
              await page.locator("#show-pressure").setChecked(showPressure);
              await page.locator("#show-impulse").setChecked(showImpulse);
              await settle();
              const frame = await page.evaluate(() => ({
                video: window.__qaVideoRect,
                texts: window.__qaPreviewTexts,
                items: window.__qaPreviewItems,
              }));
              assert.deepEqual(
                frame.video,
                baseline,
                `Footage moves when details=${showDetails}, pressure=${showPressure}, impulse=${showImpulse}`,
              );
              assert.ok(frame.texts.some((text) => text.startsWith("Frame ")));
              assert.ok(frame.texts.some((text) => text.startsWith("CSV row ")));
              assert.ok(frame.texts.includes("workflow-local.webm"));
              assert.ok(frame.texts.includes("workflow-local.csv"));
              if (showDetails) {
                for (const [key, label] of Object.entries(fields)) {
                  assert.ok(frame.texts.includes(label), `${label} must not be omitted`);
                  assert.ok(
                    frame.texts.some((text) => text.startsWith(`${key}:`)),
                    `${label} must retain its value`,
                  );
                }
              }
              for (const item of frame.items) {
                assert.ok(
                  item.left >= -0.5 && item.top >= -0.5 &&
                    item.right <= 1920.5 && item.bottom <= 1080.5,
                  `${item.text} leaves the FullHD frame: ${JSON.stringify(item)}`,
                );
              }
            }
          }
        }
        await page.locator("#show-details").check();
        await page.locator("#show-pressure").check();
        await page.locator("#show-impulse").check();
        for (const theme of ["dark", "light"]) {
          await page.locator(`[data-theme="${theme}"]`).click();
          await settle();
          const image = await page.locator("#preview").evaluate((canvas) => canvas.toDataURL("image/png"));
          await writeFile(
            join(outputDir, `fullhd-complete-record-${theme}.png`),
            Buffer.from(image.split(",")[1], "base64"),
          );
        }
        await page.locator("#preview-workspace").screenshot({
          path: join(outputDir, "fullhd-complete-record-workspace.png"),
        });
      },
    );
    await caseOf(
      "timeline toolbar, trim-only reset, and independent view navigation",
      async () => {
        await open();
        assert.equal(
          await page.locator("#timeline-snap").getAttribute("aria-pressed"),
          "true",
        );
        assert.equal(
          await page.locator("#timeline-loop").getAttribute("aria-pressed"),
          "false",
        );
        assert.equal(await page.locator("#timeline-undo").isEnabled(), false);
        const full = await viewport();
        assert.equal(full.start, 0);
        assert.ok(full.end > 7.9 && full.end < 8.1);
        await change("trim-start", 1);
        await change("trim-end", 5);
        await change("sync-offset", 0.375);
        await change("stretch-percent", 150);
        const before = await snapshot();
        await seek(3);
        await click("timeline-zoom-in");
        const zoomed = await viewport();
        assert.ok(
          zoomed.end - zoomed.start < full.end,
          "Zoom must reduce the visible time span",
        );
        assert.ok(
          zoomed.start <= 3 && zoomed.end >= 3,
          "Zoom must retain the playhead",
        );
        assert.ok(
          (await page.locator("#timeline-viewport-label").textContent()).trim(),
        );
        await page.locator("#timeline-scroll").evaluate((input) => {
          input.value = input.max;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await settle();
        const panned = await viewport();
        assert.ok(
          panned.start > zoomed.start,
          "The scrollbar must move the viewport",
        );
        assert.ok(
          Math.abs(panned.end - panned.start - (zoomed.end - zoomed.start)) <
            0.001,
        );
        assert.deepEqual(
          await snapshot(),
          before,
          "Zoom and pan must not edit media timing",
        );
        await click("timeline-fit-selection");
        const fitted = await viewport();
        assert.ok(fitted.start <= 1.001 && fitted.end >= 4.999);
        assert.ok(fitted.end - fitted.start < full.end);
        await click("timeline-zoom-out");
        const zoomedOut = await viewport();
        assert.ok(
          zoomedOut.end - zoomedOut.start > fitted.end - fitted.start,
          "Zoom out must reveal more source time",
        );
        await click("timeline-fit");
        assert.ok(Math.abs((await viewport()).end - full.end) < 0.001);
        await click("clear-trim");
        const cleared = await snapshot();
        assert.equal(cleared["trim-start"], 0);
        assert.ok(Math.abs(cleared["trim-end"] - full.end) < 0.001);
        assert.equal(cleared["sync-offset"], before["sync-offset"]);
        assert.equal(cleared["stretch-percent"], before["stretch-percent"]);
        await undo();
        assert.deepEqual(
          await snapshot(),
          before,
          "Clear trim must be one reversible edit",
        );
      },
    );

    await caseOf("exclusive Out keyboard boundaries", async () => {
      await open();
      const duration = (await viewport()).end;
      await page.locator("#trim-handle-end").press("ArrowRight");
      await settle();
      assert.ok(
        Math.abs(
          Number(await page.locator("#trim-end").inputValue()) - duration,
        ) < 0.001,
      );
      await page.locator("#trim-handle-end").press("ArrowLeft");
      await settle();
      const previous = Number(await page.locator("#trim-end").inputValue());
      assert.ok(previous < duration && previous > duration - 0.08);
      await page.locator("#trim-handle-end").press("ArrowRight");
      await settle();
      assert.ok(
        Math.abs(
          Number(await page.locator("#trim-end").inputValue()) - duration,
        ) < 0.001,
      );
    });

    await caseOf(
      "single-drag history, keyboard undo/redo, and canceled gestures",
      async () => {
        await open();
        await change("trim-start", 1);
        await change("trim-end", 6);
        await change("sync-offset", 0.25);
        await click("timeline-snap");
        const before = await snapshot();
        await drag("trim-handle-start", 30);
        const after = await snapshot();
        assert.ok(after["trim-start"] > before["trim-start"]);
        await undo(true);
        assert.deepEqual(
          await snapshot(),
          before,
          "A complete drag must require exactly one Undo",
        );
        await redo(true);
        assert.deepEqual(
          await snapshot(),
          after,
          "Redo must restore the complete drag",
        );
        for (const cancel of ["pointercancel", "Escape"]) {
          await drag("trim-handle-end", -30, { cancel });
          assert.deepEqual(
            await snapshot(),
            after,
            `${cancel} must roll back an unfinished trim`,
          );
        }
        await undo();
        assert.deepEqual(
          await snapshot(),
          before,
          "Canceled drags must not create history entries",
        );
        await redo();
        await drag("csv-track", 20);
        const moved = await snapshot();
        assert.ok(moved["sync-offset"] > after["sync-offset"]);
        await undo();
        assert.deepEqual(
          await snapshot(),
          after,
          "CSV dragging must also be one edit",
        );
        await redo();
        assert.deepEqual(await snapshot(), moved);
        await undo();
        assert.equal(await page.locator("#timeline-redo").isEnabled(), true);
        await change("sync-offset", 0.75);
        assert.equal(
          await page.locator("#timeline-redo").isEnabled(),
          false,
          "A fresh edit must discard the old redo branch",
        );
        await change("csv-anchor", 1);
        await change("csv-end-anchor", 4);
        await page.locator("#video-input").setInputFiles({
          name: "replacement-local.webm",
          mimeType: "video/webm",
          buffer: fixture,
        });
        await page.waitForFunction(
          () =>
            !document.querySelector("#frame-next").disabled &&
            document
              .querySelector("#video-track-name")
              .textContent.includes("replacement-local.webm"),
        );
        await settle();
        assert.equal(
          await page.locator("#timeline-undo").isEnabled(),
          false,
          "A new source must reset obsolete timing history",
        );
        assert.equal(await page.locator("#timeline-redo").isEnabled(), false);
        assert.equal(Number(await page.locator("#csv-anchor").inputValue()), 1);
        assert.equal(
          Number(await page.locator("#csv-end-anchor").inputValue()),
          4,
        );
      },
    );

    await caseOf("playhead snapping and temporary Alt bypass", async () => {
      await open();
      await change("sync-offset", 0.5);
      await seek(2);
      const rail = await page.locator("#tracks-body").boundingBox();
      const full = await viewport();
      const pixelsPerSecond = rail.width / (full.end - full.start);
      const nearPlayhead = 1.5 * pixelsPerSecond + 2;
      await drag("csv-track", nearPlayhead);
      assert.ok(
        Math.abs((await snapshot())["sync-offset"] - 2) < 0.00001,
        "CSV zero must snap to a nearby playhead",
      );
      await undo();
      await drag("csv-track", nearPlayhead, { alt: true });
      const bypassed = (await snapshot())["sync-offset"];
      assert.ok(
        bypassed > 2.001 && bypassed < 2 + 5 / pixelsPerSecond,
        "Alt must bypass magnetic alignment for fine adjustment",
      );
      assert.equal(
        await page.locator("#timeline-snap").getAttribute("aria-pressed"),
        "true",
        "Alt must not change the saved snap preference",
      );
    });

    await caseOf(
      "zoomed source-clock geometry across desktop, tablet, and mobile",
      async () => {
        await open();
        await change("trim-start", 1);
        await change("trim-end", 5);
        await change("sync-offset", 0.5);
        await seek(3);
        await click("timeline-fit-selection");
        for (const width of [1440, 1024, 390]) {
          await page.setViewportSize({ width, height: 1050 });
          await page.locator("#scrubber").scrollIntoViewIfNeeded();
          const range = await viewport();
          for (const fraction of [0.25, 0.5, 0.75]) {
            await seek(range.start + (range.end - range.start) * fraction);
            const errors = await page.evaluate(() => {
              const range = document.querySelector("#scrubber");
              const input = range.getBoundingClientRect();
              const rail = document
                .querySelector("#scrubber-rail")
                .getBoundingClientRect();
              const tracks = document
                .querySelector("#tracks-body")
                .getBoundingClientRect();
              const cursor = document
                .querySelector("#timeline-playhead")
                .getBoundingClientRect();
              const clip = document
                .querySelector("#trim-selection")
                .getBoundingClientRect();
              const csv = document
                .querySelector("#csv-track")
                .getBoundingClientRect();
              const min = Number(range.min),
                span = Number(range.max) - min;
              const thumb = parseFloat(
                getComputedStyle(range).getPropertyValue("--thumb-size"),
              );
              const p = (Number(range.value) - min) / span;
              const expectedX = (time) =>
                rail.left + ((time - min) / span) * rail.width;
              return {
                railStart: rail.left - tracks.left,
                railWidth: rail.width - tracks.width,
                thumb:
                  input.left +
                  thumb / 2 +
                  p * (input.width - thumb) -
                  (cursor.left + cursor.width / 2),
                clipStart:
                  clip.left -
                  expectedX(
                    Number(document.querySelector("#trim-start").value),
                  ),
                clipEnd:
                  clip.right -
                  expectedX(Number(document.querySelector("#trim-end").value)),
                csvStart:
                  csv.left -
                  expectedX(
                    Number(document.querySelector("#sync-offset").value),
                  ),
              };
            });
            for (const [name, error] of Object.entries(errors))
              assert.ok(
                Math.abs(error) < 0.8,
                `${name} must use the same zoomed clock at ${width}px: ${error}px`,
              );
          }
          const rail = await page.locator("#scrubber-rail").boundingBox();
          await page.mouse.click(
            rail.x + rail.width * 0.6,
            rail.y + rail.height / 2,
          );
          await page.waitForFunction(
            () => !document.querySelector("#source-video").seeking,
          );
          const actual = await page
            .locator("#source-video")
            .evaluate((v) => v.currentTime);
          assert.ok(
            Math.abs(actual - (range.start + (range.end - range.start) * 0.6)) <
              0.03,
          );
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth + 1,
            ),
            false,
            `Editor must fit ${width}px`,
          );
        }
        await page.screenshot({
          path: join(outputDir, "editor-workflow-mobile.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 1440, height: 1050 });
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({
          path: join(outputDir, "editor-workflow-desktop.png"),
          fullPage: true,
        });
        await page.locator("#meta-motor").fill("ARC-24 / DEVELOPMENT");
        await page.locator("#meta-testDate").fill("2026-10-17");
        await page.locator("#more-test-details").evaluate((element) => {
          element.open = true;
        });
        for (const [id, value] of Object.entries({
          "meta-testId": "TEST 024",
          "meta-location": "Test stand 01",
          "meta-logger": "Load cell recorder",
          "meta-sampleRate": "50 Hz",
          "meta-camera": "High-speed camera / 120 FPS",
          "meta-notes": "Calibrated sensors. Raw telemetry.",
        }))
          await page.locator(`#${id}`).fill(value);
        await settle();
        const saveFrame = async (name) => {
          const image = await page
            .locator("#preview")
            .evaluate((canvas) => canvas.toDataURL("image/png"));
          await writeFile(
            join(outputDir, name),
            Buffer.from(image.split(",")[1], "base64"),
          );
        };
        await saveFrame("video-overlay-dark.png");
        await click("tab-overlay");
        await page.locator('[data-theme="light"]').click();
        await page.locator("#show-impulse").check();
        await page.locator("#overlay-height").evaluate((input) => {
          input.value = "5";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await settle();
        await saveFrame("video-overlay-light.png");
        await page.locator("#frame-aspect").selectOption("portrait");
        await settle();
        await saveFrame("video-overlay-portrait.png");
      },
    );

    await caseOf(
      "selected-range loop and normal selected-end playback",
      async () => {
        await open();
        await change("trim-start", 1);
        await change("trim-end", 1.6);
        await seek(1.4);
        await click("timeline-loop");
        assert.equal(
          await page.locator("#timeline-loop").getAttribute("aria-pressed"),
          "true",
        );
        await click("play-button");
        await page.waitForFunction(
          () => {
            const video = document.querySelector("#source-video");
            return (
              !video.paused &&
              !video.seeking &&
              video.currentTime >= 1 &&
              video.currentTime < 1.2
            );
          },
          undefined,
          { timeout: 5000 },
        );
        assert.deepEqual(await snapshot(), {
          "trim-start": 1,
          "trim-end": 1.6,
          "sync-offset": 0,
          "stretch-percent": 100,
        });
        await click("play-button");
        await click("timeline-loop");
        await seek(1.4);
        await click("play-button");
        await page.waitForFunction(
          () => {
            const video = document.querySelector("#source-video");
            return (
              video.paused &&
              !video.seeking &&
              video.currentTime >= 1.54 &&
              video.currentTime < 1.6
            );
          },
          undefined,
          { timeout: 5000 },
        );
        assert.equal(
          await page.locator("#timeline-loop").getAttribute("aria-pressed"),
          "false",
        );
      },
    );

    await caseOf(
      "VFR pending-seek In/Out shortcuts use actual source-frame boundaries",
      async () => {
        const mediaModule = await readFile(
          new URL(
            "../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs",
            import.meta.url,
          ),
          "utf8",
        );
        await page.route("**/__qa__/workflow-media.mjs", (route) =>
          route.fulfill({ contentType: "text/javascript", body: mediaModule }),
        );
        await page.goto(baseURL);
        const vfr = Buffer.from(
          await page.evaluate(async () => {
            const { Output, BufferTarget, Mp4OutputFormat, CanvasSource } =
              await import(`${location.origin}/__qa__/workflow-media.mjs`);
            const canvas = new OffscreenCanvas(320, 180),
              context = canvas.getContext("2d");
            const target = new BufferTarget(),
              output = new Output({ target, format: new Mp4OutputFormat() });
            const source = new CanvasSource(canvas, {
              codec: "avc",
              bitrate: 250000,
            });
            output.addVideoTrack(source);
            await output.start();
            const times = [0, 0.05, 0.2, 0.23, 0.7, 1, 1.05, 1.7, 2, 2.8, 3];
            for (let i = 0; i < times.length - 1; i++) {
              context.fillStyle = i % 2 ? "#d1e0e8" : "#283c32";
              context.fillRect(0, 0, 320, 180);
              context.fillStyle = "#d58d3e";
              context.fillRect(i * 22, 40, 30, 90);
              await source.add(times[i], times[i + 1] - times[i]);
            }
            source.close();
            await output.finalize();
            return Array.from(new Uint8Array(target.buffer));
          }),
        );
        await open(vfr, "workflow-variable-frames.mp4");
        assert.match(
          await page.locator("#timing-video-rate").textContent(),
          /VFR/,
        );
        const markQueued = async (times, key, field, expected) => {
          await blur();
          await page.evaluate(
            ({ times, key }) => {
              const input = document.querySelector("#scrubber");
              for (const time of times) {
                input.value = String(time);
                input.dispatchEvent(new Event("input", { bubbles: true }));
              }
              document.body.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key,
                  code: `Key${key.toUpperCase()}`,
                  bubbles: true,
                }),
              );
            },
            { times, key },
          );
          await page.waitForFunction(
            ({ field, expected }) =>
              Math.abs(
                Number(document.getElementById(field).value) - expected,
              ) < 0.00001,
            { field, expected },
          );
          await page.waitForFunction(
            () => !document.querySelector("#source-video").seeking,
          );
          await settle();
        };
        await markQueued([0.1, 2.5, 0.75], "i", "trim-start", 0.7);
        await markQueued([0.1, 2.5, 1.1], "o", "trim-end", 1.7);
        assert.match(
          await page.locator("#video-selected-frames").textContent(),
          /5–7 · 3 frames/,
        );
        await seek(1.05);
        await click("frame-next");
        await page.waitForFunction(
          () => !document.querySelector("#source-video").seeking,
        );
        assert.ok(
          Math.abs(
            (await page
              .locator("#source-video")
              .evaluate((v) => v.currentTime)) - 1.7,
          ) < 0.00001,
          "VFR step must follow encoded timestamps rather than an inferred average FPS",
        );
        await click("frame-back");
        await page.waitForFunction(
          () => !document.querySelector("#source-video").seeking,
        );
        assert.ok(
          Math.abs(
            (await page
              .locator("#source-video")
              .evaluate((v) => v.currentTime)) - 1.05,
          ) < 0.00001,
        );
      },
    );
  } finally {
    await page.close();
  }
  return { failures, requests };
}
