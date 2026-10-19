import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VIDEO_FRAMING,
  videoFraming,
  frameVideo,
  moveVideoFraming,
} from "../src/video-framing.js";

const body = { x: 0, y: 68, width: 1920, height: 970 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `Expected ${actual} to equal ${expected}`);

test("default video framing preserves the entire landscape and portrait source", () => {
  for (const [width, height] of [[832, 464], [1920, 1080], [1080, 1920], [1000, 1000]]) {
    const result = frameVideo(width, height, body);
    near(result.width / result.height, width / height);
    assert.ok(result.x >= body.x - 1e-8 && result.y >= body.y - 1e-8);
    assert.ok(result.x + result.width <= body.x + body.width + 1e-8);
    assert.ok(result.y + result.height <= body.y + body.height + 1e-8);
    near(result.x + result.width / 2, body.x + body.width / 2);
    near(result.y + result.height / 2, body.y + body.height / 2);
  }
});

test("zoom keeps the image center fixed and pan uses body coordinates", () => {
  const original = frameVideo(832, 464, body);
  const framed = frameVideo(832, 464, body, { videoScale: 150, videoX: -20, videoY: 15 });
  near(framed.width, original.width * 1.5);
  near(framed.height, original.height * 1.5);
  near(framed.x + framed.width / 2, body.width * 0.3);
  near(framed.y + framed.height / 2, body.y + body.height * 0.65);
});

test("framing is invariant across export sizes and translated body rectangles", () => {
  const style = { videoScale: 75, videoX: -12.5, videoY: 20 };
  const original = frameVideo(1080, 1920, body, style);
  const factor = 2 / 3;
  const scaledBody = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, value * factor]));
  const scaled = frameVideo(1080, 1920, scaledBody, style);
  for (const key of ["x", "y", "width", "height"]) near(scaled[key], original[key] * factor);
  const translated = frameVideo(1080, 1920, { ...body, x: 42, y: body.y + 99 }, style);
  near(translated.x, original.x + 42);
  near(translated.y, original.y + 99);
});

test("dragging uses body percentages without accumulating rounding errors", () => {
  const initial = { videoScale: 125, videoX: -5, videoY: 10 };
  const moved = moveVideoFraming(initial, 192, -97, body);
  assert.deepEqual(moved, { videoScale: 125, videoX: 5, videoY: 0 });
  assert.deepEqual(initial, { videoScale: 125, videoX: -5, videoY: 10 });
  assert.deepEqual(moveVideoFraming(moved, -192, 97, body), initial);
  const smallBody = { ...body, width: body.width / 2, height: body.height / 2 };
  assert.deepEqual(moveVideoFraming(initial, 96, -48.5, smallBody), moved);
});

test("invalid placement values normalize and movement clamps at the allowed limits", () => {
  assert.deepEqual(videoFraming(), DEFAULT_VIDEO_FRAMING);
  assert.deepEqual(videoFraming({ videoScale: NaN, videoX: Infinity, videoY: undefined }), DEFAULT_VIDEO_FRAMING);
  assert.deepEqual(videoFraming({ videoScale: 999, videoX: -70, videoY: 51 }),
    { videoScale: 200, videoX: -50, videoY: 50 });
  assert.deepEqual(moveVideoFraming({ videoScale: 20 }, 100000, -100000, body),
    { videoScale: 50, videoX: 50, videoY: -50 });
  assert.throws(() => frameVideo(0, 720, body), RangeError);
  assert.throws(() => frameVideo(1280, 720, { ...body, height: 0 }), RangeError);
  assert.throws(() => moveVideoFraming({}, NaN, 0, body), RangeError);
});
