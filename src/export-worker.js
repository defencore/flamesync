// @ts-check
import { UserError, errorMessage } from "./messages.js";

import {
  Input,
  BlobSource,
  ALL_FORMATS,
  Output,
  BufferTarget,
  Mp4OutputFormat,
  WebMOutputFormat,
  Conversion,
  Quality,
} from "mediabunny";
import { drawComposition } from "./composition.js";
import { chartPoints, compositionSize, validateTimeScale } from "./data.js";

/** @typedef {{file:File, data:import('./data.js').BurnData, style:typeof import('./overlay.js').defaultStyle,
 * offset:number, timeScale:number, start:number, end:number, format:'mp4'|'webm', maxEdge:number, fps:number,
 * quality:import('mediabunny').QualityLevel, keepAudio:boolean,
 * metadata:typeof import('./overlay.js').defaultMetadata,
 * sourceInfo:{width:number,height:number,fps:number,timestamps:Float64Array,end:number,videoName:string,logName:string},
 * measurement:{start:number,end:number}|null}} ExportJob */
/** @param {MessageEvent<ExportJob>} event */
self.onmessage = async ({ data: job }) => {
  let input;
  try {
    validateTimeScale(job.timeScale);
    if (
      typeof VideoEncoder === "undefined" ||
      typeof VideoDecoder === "undefined"
    ) {
      throw new UserError(
        "This browser does not support WebCodecs export. Use a recent Chrome, Edge, or Safari browser.",
      );
    }
    input = new Input({
      source: new BlobSource(job.file),
      formats: ALL_FORMATS,
    });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new UserError("No video track was found in this file.");
    const sourceWidth = await track.getDisplayWidth();
    const sourceHeight = await track.getDisplayHeight();
    const size = compositionSize(
      sourceWidth,
      sourceHeight,
      job.maxEdge,
      job.style.frameAspect,
    );
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx)
      throw new UserError("A video rendering canvas could not be created.");
    const reduced = chartPoints(job.data, Math.max(1400, size.width * 2));
    const target = new BufferTarget();
    const output = new Output({
      target,
      format:
        job.format === "mp4"
          ? new Mp4OutputFormat({ fastStart: "in-memory" })
          : new WebMOutputFormat(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      trim: { start: job.start, end: job.end },
      // Copy compatible audio only when exact timestamps can be preserved.
      copy: { shiftTolerance: 0 },
      video: {
        codec: job.format === "mp4" ? "avc" : "vp9",
        processedWidth: size.width,
        processedHeight: size.height,
        ...(job.fps ? { frameRate: job.fps } : {}),
        quality: new Quality(job.quality),
        keyFrameInterval: 2,
        allowTransformationMetadata: false,
        process(sample) {
          // Conversion rebases samples to the trimmed output's time zero.
          drawComposition(
            ctx,
            size.width,
            size.height,
            (context, x, y, width, height) =>
              sample.draw(context, x, y, width, height),
            sourceWidth,
            sourceHeight,
            job.data,
            reduced,
            sample.timestamp + job.start,
            job.offset,
            job.timeScale,
            job.style,
            job.metadata,
            job.sourceInfo,
            job.measurement,
          );
          return canvas;
        },
      },
      audio: job.keepAudio
        ? { codec: job.format === "mp4" ? "aac" : "opus" }
        : { discard: true },
      tags: { title: job.style.title },
      showWarnings: false,
    });
    if (!conversion.isValid || !conversion.utilizedTracks.includes(track)) {
      throw new UserError(
        "The video codec cannot be decoded or the selected format cannot be encoded in this browser. Try the other export format or a different browser.",
      );
    }
    const missingAudio = conversion.discardedTracks.find(
      (d) => d.track.type === "audio" && d.reason !== "discarded_by_user",
    );
    if (job.keepAudio && missingAudio) {
      throw new UserError(
        "The original audio cannot be encoded in this format on this browser. Choose WebM / MP4, another browser, or turn off “Keep original audio.”",
      );
    }
    conversion.onProgress = (progress) =>
      self.postMessage({ type: "progress", progress });
    await conversion.execute();
    if (!target.buffer?.byteLength)
      throw new UserError("The encoder produced an empty file.");
    self.postMessage(
      { type: "done", buffer: target.buffer },
      { transfer: [target.buffer] },
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      error: errorMessage(error),
    });
  } finally {
    input?.dispose();
  }
};
