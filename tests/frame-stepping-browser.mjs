import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacketSink,
  Input,
} from "mediabunny";
import { compositionGeometry } from "../src/composition.js";
import { defaultStyle } from "../src/overlay.js";

/** Verify real decoded frames, including fractional PTS rounded by Chrome. */
export async function verifyFrameStepping({ browser, baseURL, outputDir }) {
  const failures = [];
  const requests = [];
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    locale: "en-US",
  });
  page.on("pageerror", (error) =>
    failures.push(`Frame stepping: ${error.message}`),
  );
  page.on("console", (entry) => {
    if (entry.type() === "error")
      failures.push(`Frame stepping: ${entry.text()}`);
  });
  page.on("request", (request) =>
    requests.push({ url: request.url(), method: request.method() }),
  );
  const mediaModule = await readFile(
    new URL(
      "../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  // Fixtures and the test-only library route never enter the production build.
  await page.route("**/__qa__/step-media.mjs", (route) =>
    route.fulfill({ contentType: "text/javascript", body: mediaModule }),
  );
  try {
    for (const scenario of [
      { label: "29.97-fps", fps: 30000 / 1001 },
      { label: "59.94-fps", fps: 60000 / 1001 },
      { label: "60-fps", fps: 60 },
      { label: "120-fps", fps: 120 },
      { label: "irregular-vfr", fps: 0 },
    ]) {
      try {
        await page.goto(baseURL);
        await page.locator("#language-select").selectOption("en");
        const fixture = Buffer.from(
          await page.evaluate(async ({ fps }) => {
            const { Output, BufferTarget, Mp4OutputFormat, CanvasSource } =
              await import(`${location.origin}/__qa__/step-media.mjs`);
            const canvas = new OffscreenCanvas(320, 180);
            const context = canvas.getContext("2d");
            const target = new BufferTarget();
            const output = new Output({
              target,
              format: new Mp4OutputFormat(),
            });
            const source = new CanvasSource(canvas, {
              codec: "avc",
              bitrate: 500000,
            });
            output.addVideoTrack(source, fps ? { frameRate: fps } : {});
            await output.start();
            let timestamp = 0;
            for (let index = 0; index < 80; index++) {
              const duration = fps
                ? 1 / fps
                : [1 / 120, 1 / 60, 1001 / 30000, 0.011237, 0.042719][
                    index % 5
                  ];
              context.fillStyle = "#636363";
              context.fillRect(0, 0, 320, 180);
              // Eight wide binary bars identify the frame from decoded pixels.
              for (let bit = 0; bit < 8; bit++) {
                context.fillStyle =
                  (index + 1) & (1 << bit) ? "white" : "black";
                context.fillRect(32 + bit * 32, 40, 32, 100);
              }
              context.fillStyle = "white";
              context.font = "14px monospace";
              context.fillText(`Source frame ${index + 1}`, 32, 24);
              await source.add(timestamp, duration);
              timestamp += duration;
            }
            source.close();
            await output.finalize();
            return Array.from(new Uint8Array(target.buffer));
          }, scenario),
        );
        const input = new Input({
          source: new BufferSource(new Uint8Array(fixture)),
          formats: ALL_FORMATS,
        });
        const track = await input.getPrimaryVideoTrack();
        assert.ok(track, `${scenario.label}: fixture must contain video`);
        const timestamps = [];
        for await (const packet of new EncodedPacketSink(track).packets(
          undefined,
          undefined,
          { metadataOnly: true },
        ))
          timestamps.push(packet.timestamp);
        input.dispose();
        timestamps.sort((a, b) => a - b);
        assert.equal(timestamps.length, 80);
        await page.locator("#video-input").setInputFiles({
          name: `frame-step-${scenario.label}.mp4`,
          mimeType: "video/mp4",
          buffer: fixture,
        });
        await page.waitForFunction(
          () =>
            document.querySelector("#video-frame-count").textContent === "80" &&
            !document.querySelector("#frame-next").disabled &&
            !document.querySelector("#source-video").seeking,
        );
        assert.equal(
          /VFR/.test(await page.locator("#timing-video-rate").textContent()),
          !scenario.fps,
          `${scenario.label}: source timing classification`,
        );
        const dimensions = await page
          .locator("#preview")
          .evaluate((canvas) => ({
            width: canvas.width,
            height: canvas.height,
          }));
        const videoRect = compositionGeometry(
          dimensions.width,
          dimensions.height,
          320,
          180,
          defaultStyle,
        ).video;
        const read = () =>
          page.evaluate((box) => {
            const video = document.querySelector("#source-video");
            const decoded = new OffscreenCanvas(320, 180);
            const source = decoded.getContext("2d", {
              willReadFrequently: true,
            });
            source.drawImage(video, 0, 0, 320, 180);
            const preview = document.querySelector("#preview").getContext("2d");
            const ordinal = (context, rect) => {
              let result = 0;
              for (let bit = 0; bit < 8; bit++) {
                const x = rect.x + ((48 + bit * 32) / 320) * rect.width;
                const y = rect.y + (90 / 180) * rect.height;
                const rgb = context.getImageData(
                  Math.floor(x),
                  Math.floor(y),
                  1,
                  1,
                ).data;
                if ((rgb[0] + rgb[1] + rgb[2]) / 3 > 128) result |= 1 << bit;
              }
              return result;
            };
            return {
              counter: Number(
                document.querySelector("#video-frame-number").textContent,
              ),
              source: ordinal(source, { x: 0, y: 0, width: 320, height: 180 }),
              preview: ordinal(preview, box),
              nativeTime: video.currentTime,
              displayedTime: Number(
                document
                  .querySelector("#video-frame-time")
                  .textContent.replace(" s", ""),
              ),
              seeking: video.seeking,
            };
          }, videoRect);
        const verify = async (expected, action) => {
          await page
            .waitForFunction(
              (frame) =>
                !document.querySelector("#source-video").seeking &&
                Number(
                  document.querySelector("#video-frame-number").textContent,
                ) === frame,
              expected,
              { timeout: 2500 },
            )
            .catch(async (error) => {
              throw new Error(
                `${scenario.label}: ${action}, expected frame ${expected}; ${JSON.stringify(await read())}`,
                { cause: error },
              );
            });
          // Let pending presentation callbacks update the shared composition too.
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          const actual = await read();
          const context = `${scenario.label}: ${action}, frame ${expected}: ${JSON.stringify(actual)}`;
          assert.equal(actual.counter, expected, context);
          assert.equal(
            actual.source,
            expected,
            `Decoded source must advance: ${context}`,
          );
          assert.equal(
            actual.preview,
            expected,
            `Composed preview must advance: ${context}`,
          );
          assert.ok(
            actual.nativeTime >= timestamps[expected - 1] &&
              actual.nativeTime < (timestamps[expected] ?? Infinity) &&
              Math.abs(actual.nativeTime - timestamps[expected - 1]) <=
                0.000004,
            `Native seek must land inside the indexed frame: ${context}`,
          );
          assert.ok(
            Math.abs(actual.displayedTime - timestamps[expected - 1]) <=
              0.0000011,
            `Frame timestamp must use the encoded PTS: ${context}`,
          );
        };
        const clicks = (id, count = 1) =>
          page.evaluate(
            ({ id, count }) => {
              const button = document.getElementById(id);
              for (let index = 0; index < count; index++) button.click();
            },
            { id, count },
          );
        await verify(1, "initial frame");
        for (let frame = 2; frame <= 25; frame++) {
          await clicks("frame-next");
          await verify(frame, "sequential Next");
        }
        if (scenario.fps === 60 && outputDir)
          await page.locator("#preview-workspace").screenshot({
            path: join(outputDir, "frame-stepping-fixed.png"),
          });
        for (let frame = 24; frame >= 1; frame--) {
          await clicks("frame-back");
          await verify(frame, "sequential Back");
        }
        await clicks("frame-next", 20);
        await verify(21, "20 rapid Next clicks");
        await clicks("frame-back", 20);
        await verify(1, "20 rapid Back clicks");
        await clicks("frame-back", 3);
        await verify(1, "Back clamps to the first source frame");
        assert.equal(await page.locator("#frame-back").isEnabled(), false);
        await page.locator("#scrubber").evaluate((scrubber, time) => {
          scrubber.value = String(time);
          scrubber.dispatchEvent(new Event("input", { bubbles: true }));
        }, timestamps.at(-1));
        await verify(80, "seek to the last source frame");
        await clicks("frame-next", 3);
        await verify(80, "Next clamps to the last source frame");
        assert.equal(await page.locator("#frame-next").isEnabled(), false);
        console.log(
          `PASS: ${scenario.label} repeated and rapid frame stepping matches decoded source, composed preview, frame counter, and encoded timestamps`,
        );
      } catch (error) {
        failures.push(
          `Frame stepping (${scenario.label}): ${error.stack || error.message || String(error)}`,
        );
        if (outputDir)
          await page
            .screenshot({
              path: join(
                outputDir,
                `frame-stepping-${scenario.label}-failure.png`,
              ),
              fullPage: true,
            })
            .catch(() => {});
      }
    }
  } finally {
    await page.close();
  }
  return { failures, requests };
}
