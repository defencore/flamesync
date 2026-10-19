import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { verifyTemplates } from "./templates-browser.mjs";

const baseURL = process.argv[2] || "http://localhost:8080";
const origin = new URL(baseURL).origin;
const outputDir = process.env.TEST_RESULTS_DIR || await mkdtemp(join(tmpdir(), "flamesync-templates-qa-"));
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
try {
  const { failures, requests } = await verifyTemplates({ browser, baseURL, outputDir });
  assert.deepEqual(failures, [], "Video template browser regressions must pass");
  assert.deepEqual(requests.filter(({ url, method }) => /^https?:/.test(url) &&
    (new URL(url).origin !== origin || method !== "GET")), [],
  "Video template processing must stay local without uploads or third-party requests");
} finally {
  await browser.close();
  if (!process.env.TEST_RESULTS_DIR) await rm(outputDir, { recursive: true, force: true });
}
