import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { verifyTheory } from "./theory-browser.mjs";

const baseURL = process.argv[2] || "http://localhost:8080";
const origin = new URL(baseURL).origin;
const outputDir = process.env.TEST_RESULTS_DIR || await mkdtemp(join(tmpdir(), "flamesync-theory-qa-"));
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
try {
  const { failures, requests } = await verifyTheory({ browser, baseURL, outputDir });
  assert.deepEqual(failures, [], "Theoretical reference browser regressions must pass");
  assert.deepEqual(requests.filter(({ url, method }) => /^https?:/.test(url) &&
    (new URL(url).origin !== origin || method !== "GET")), [],
  "Theoretical comparisons must stay in the browser without uploads or third-party requests");
} finally {
  await browser.close();
  if (!process.env.TEST_RESULTS_DIR) await rm(outputDir, { recursive: true, force: true });
}
