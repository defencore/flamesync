import { clamp, containRect } from "./data.js";

export const DEFAULT_VIDEO_FRAMING = Object.freeze({
  videoScale: 100,
  videoX: 0,
  videoY: 0,
});

/** Normalize only composition placement; media and telemetry clocks are untouched. */
export function videoFraming(style = {}) {
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  return {
    videoScale: clamp(finite(style.videoScale, 100), 50, 200),
    videoX: clamp(finite(style.videoX, 0), -50, 50),
    videoY: clamp(finite(style.videoY, 0), -50, 50),
  };
}

/** Fit the full source first, then zoom about the body center and pan in body percentages. */
export function frameVideo(sourceWidth, sourceHeight, body, style = {}) {
  if (![sourceWidth, sourceHeight, body.width, body.height].every(
    (value) => Number.isFinite(value) && value > 0,
  ) || ![body.x, body.y].every(Number.isFinite))
    throw new RangeError("Video framing requires a positive source and body rectangle.");
  const framing = videoFraming(style);
  const fitted = containRect(sourceWidth, sourceHeight, body);
  const width = fitted.width * framing.videoScale / 100;
  const height = fitted.height * framing.videoScale / 100;
  return {
    x: body.x + (body.width - width) / 2 + body.width * framing.videoX / 100,
    y: body.y + (body.height - height) / 2 + body.height * framing.videoY / 100,
    width,
    height,
  };
}

/** Drag distances use output pixels, making movement independent of preview and export size. */
export function moveVideoFraming(initial, deltaX, deltaY, body) {
  if (![deltaX, deltaY, body.width, body.height].every(Number.isFinite) ||
      body.width <= 0 || body.height <= 0)
    throw new RangeError("Video movement requires finite distances and a positive body rectangle.");
  const framing = videoFraming(initial);
  return videoFraming({
    ...framing,
    videoX: framing.videoX + deltaX / body.width * 100,
    videoY: framing.videoY + deltaY / body.height * 100,
  });
}
