import { drawOverlay, drawEmpty } from "./overlay.js";
import { compositionGeometry } from "./composition-layout.js";
import { drawVideoDetails } from "./video-details.js";
import { drawSourceStrip } from "./source-strip.js";
import { drawOnVideoDetails, drawOnVideoSources } from "./on-video-details.js";

export { compositionGeometry } from "./composition-layout.js";

// Preview and export share fixed regions and the same source clocks.
/**
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {number} width @param {number} height
 * @param {{data:import('./data.js').BurnData,reduced:import('./data.js').DataPoint[],name:string,offset:number,timeScale:number}|null} [theory]
 * @param {((ctx:CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x:number, y:number, width:number, height:number) => void) | null} paintVideo
 * @param {{start:number,end:number,visible?:boolean}|null} measurement
 */
export function drawComposition(
  ctx,
  width,
  height,
  paintVideo,
  sourceWidth,
  sourceHeight,
  data,
  reduced,
  videoTime,
  offset,
  timeScale,
  style,
  metadata,
  sourceInfo,
  measurement = null,
  theory = null,
) {
  ctx.save();
  const geometry = compositionGeometry(
    width,
    height,
    sourceWidth,
    sourceHeight,
    style,
  );
  ctx.fillStyle = style.layout !== "stacked" && style.theme === "light" ? "#e4e9ee" : "#0b1218";
  ctx.fillRect(0, 0, width, height);
  const video = geometry.video;
  ctx.save();
  ctx.beginPath();
  ctx.rect(video.x, video.y, video.width, video.height);
  ctx.clip();
  if (paintVideo) paintVideo(ctx, video.x, video.y, video.width, video.height);
  else drawEmpty(ctx, width, height);
  ctx.restore();
  if (style.layout === "stacked")
    drawOnVideoDetails(
      ctx, width, height, metadata, sourceInfo, data,
      videoTime, offset, timeScale, style,
    );
  if (geometry.info && style.showDetails)
    drawVideoDetails(
      ctx,
      geometry.info,
      metadata,
      data,
      style,
      videoTime,
      offset,
      timeScale,
    );
  drawOverlay(
    ctx,
    width,
    height,
    data,
    reduced,
    videoTime,
    offset,
    timeScale,
    style.layout === "full" ? { ...style, opacity: 100 } : style,
    measurement,
    theory,
  );
  if (style.layout === "stacked")
    drawOnVideoSources(ctx, width, height, sourceInfo, theory, style);
  else
    drawSourceStrip(
      ctx,
      width,
      height,
      sourceInfo,
      data,
      videoTime,
      offset,
      timeScale,
      style,
    );
  ctx.restore();
}
