// @ts-check
import { UserError } from "./messages.js";

/** Read a temporary metadata probe and release it on every completion path.
 * @param {string} url
 * @param {{signal?:AbortSignal,createVideo?:()=>HTMLVideoElement}} [options]
 * @returns {Promise<{duration:number,width:number,height:number}>}
 */
export function readVideoMetadata(url, { signal, createVideo = () => document.createElement("video") } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const probe = createVideo();
    let finished = false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const cancel = () => finish(signal?.reason);
    /** @param {unknown} [error] */
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      const metadata = { duration: probe.duration, width: probe.videoWidth, height: probe.videoHeight };
      probe.onloadedmetadata = probe.onerror = null;
      probe.removeAttribute("src");
      probe.load();
      if (error) reject(error);
      else if (!Number.isFinite(metadata.duration) || metadata.duration <= 0.001 || !metadata.width || !metadata.height)
        reject(new UserError("The video needs a finite duration and a playable video track."));
      else resolve(metadata);
    }
    probe.preload = "metadata";
    probe.onloadedmetadata = () => finish();
    probe.onerror = () => finish(new UserError("This browser cannot play this video. Try an H.264 MP4 or VP9 WebM file."));
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => finish(new UserError("The video metadata could not be read. Try an MP4 or WebM file supported by your browser.")), 20000);
    try { probe.src = url; }
    catch (error) { finish(error); }
  });
}
