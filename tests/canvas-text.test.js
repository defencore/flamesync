import test from "node:test";
import assert from "node:assert/strict";
import { filenameLabel, textLines } from "../src/canvas-text.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const parts = (text) => Array.from(segmenter.segment(text), (part) => part.segment);
const context = {
  measureText(text) {
    return {
      width: parts(text).reduce(
        (sum, part) => sum + (part === " " ? 0.5 : part === "W" ? 1.7 : 1),
        0,
      ),
    };
  },
};

function assertFit(lines, width) {
  for (const line of lines) {
    assert.ok(context.measureText(line).width <= width, JSON.stringify(line));
    assert.doesNotMatch(line, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  }
}

test("canvas text wraps words and retains explicit blank lines", () => {
  assert.deepEqual(textLines(context, "Alpha beta gamma", 10, 3), [
    "Alpha beta",
    "gamma",
  ]);
  assert.deepEqual(textLines(context, "Alpha\r\n\r\nBeta", 10, 3), [
    "Alpha",
    "",
    "Beta",
  ]);
  assert.deepEqual(textLines(context, " Alpha   beta\t gamma ", 10, 3), [
    "Alpha beta",
    "gamma",
  ]);
});

test("canvas text breaks long Ukrainian words within measured bounds", () => {
  const word = "Експериментальневипробуваннядвигуна";
  const complete = textLines(context, word, 8, 8);
  assert.equal(complete.join(""), word);
  assertFit(complete, 8);
  const clipped = textLines(context, word, 8, 2);
  assert.equal(clipped.length, 2);
  assert.ok(clipped[1].endsWith("…"));
  assertFit(clipped, 8);
});

test("line clamping reserves room for ellipsis and measures proportional glyphs", () => {
  const lines = textLines(context, "WWWW WWWW WWWW", 7, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith("…"));
  assertFit(lines, 7);
  assert.deepEqual(textLines(context, "Alpha\nBeta", 5, 1), ["Alph…"]);
  assert.deepEqual(textLines(context, "abc", 1, 1), ["…"]);
});

test("wrapping never splits combining characters, emoji, or family sequences", () => {
  const clusters = ["і\u0308", "👩🏽‍🔬", "👨‍👩‍👧‍👦", "🇺🇦"];
  const text = clusters.join("").repeat(4);
  const lines = textLines(context, text, 3, 8);
  assert.equal(lines.join(""), text);
  for (const line of lines) {
    assert.ok(parts(line).every((part) => clusters.includes(part)));
  }
  assertFit(lines, 3);
  const clipped = textLines(context, text, 3, 2);
  assert.ok(clipped[1].endsWith("…"));
  assertFit(clipped, 3);
});

test("filename fitting keeps the prefix and full extension", () => {
  for (const name of [
    "2026-10-16_Випробування_двигуна_номер_123.csv",
    "2026-10-16_WWWWWWWWWWWWWWWWWWW.mp4",
    "🔥👩🏽‍🔬👨‍👩‍👧‍👦🇺🇦_дуже_довга_назва_відео.mp4",
  ]) {
    const fitted = filenameLabel(context, name, 16);
    assert.ok(fitted.includes("…"));
    assert.ok(fitted.startsWith(parts(name)[0]));
    assert.ok(fitted.endsWith(name.slice(name.lastIndexOf("."))));
    assertFit([fitted], 16);
  }
});

test("filename labels preserve Unicode clusters around the middle ellipsis", () => {
  const stem = "👩🏽‍🔬👨‍👩‍👧‍👦🇺🇦і\u0308".repeat(5);
  const fitted = filenameLabel(context, `${stem}.csv`, 12);
  assert.ok(fitted.endsWith(".csv"));
  const clusters = parts(stem);
  const retained = fitted.slice(0, -4).replace("…", "");
  assert.ok(parts(retained).every((part) => clusters.includes(part)));
  assertFit([fitted], 12);
});

test("narrow filename widths stay bounded even when the extension cannot fit", () => {
  const name = "recording.reallylongextension";
  for (let width = 0; width < 25; width += 0.5) {
    const label = filenameLabel(context, name, width);
    assertFit([label], width);
    if (width >= context.measureText("….reallylongextension").width)
      assert.ok(label.endsWith(".reallylongextension"));
  }
  assert.equal(filenameLabel(context, "clip.mp4", 5), "….mp4");
});

test("empty values and unusable regions produce no overflowing content", () => {
  assert.deepEqual(textLines(context, "", 10), []);
  assert.deepEqual(textLines(context, null, 10), []);
  assert.deepEqual(textLines(context, "data", 0), []);
  assert.deepEqual(textLines(context, "data", 10, 0), []);
  assert.equal(filenameLabel(context, "clip.mp4", 0), "");
  assert.equal(filenameLabel(context, "clip.mp4", 0.5), "");
  assert.equal(filenameLabel(context, "clip.mp4", 10), "clip.mp4");
  assert.equal(filenameLabel(context, "clip\nvideo.mp4", 30), "clip video.mp4");
});
