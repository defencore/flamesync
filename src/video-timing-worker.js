// @ts-check
import { UserError, errorMessage } from "./messages.js";
import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from "mediabunny";
import { summarizeFrameTiming } from "./timing.js";

/** @param {MessageEvent<{file:File}>} event */
self.onmessage = async ({ data: { file } }) => {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new UserError("No video track was found.");
    const sink = new EncodedPacketSink(track);
    const values = [];
    let end = 0;
    for await (const packet of sink.packets(undefined, undefined, {
      metadataOnly: true,
    })) {
      if (packet.timestamp >= 0) values.push(packet.timestamp);
      end = Math.max(end, packet.timestamp + packet.duration);
      if (values.length % 10000 === 0)
        self.postMessage({ type: "progress", frames: values.length });
    }
    // Decode order may differ from presentation order (for example H.264 B frames).
    const sorted = Float64Array.from(values).sort();
    values.length = 0;
    let unique = 0;
    for (let i = 0; i < sorted.length; i++)
      if (!unique || sorted[i] !== sorted[unique - 1])
        sorted[unique++] = sorted[i];
    const timestamps =
      unique === sorted.length ? sorted : sorted.slice(0, unique);
    const timing = summarizeFrameTiming(
      timestamps,
      end,
      await track.getTimeResolution(),
    );
    const info = { ...timing, codec: await track.getCodecParameterString() };
    self.postMessage(
      { type: "done", timing: info, timestamps: timestamps.buffer },
      { transfer: [timestamps.buffer] },
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      error: errorMessage(error),
    });
  } finally {
    input.dispose();
  }
};
