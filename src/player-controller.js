import { message, errorMessage, UserError } from "./messages.js";
import { bindText, bindAttribute } from "./i18n.js";
import { $ } from "./dom.js";
import { clamp, formatTime, dataTimeAt, videoTimeAt } from "./data.js";
import {
  adjacentFrameTime,
  frameInfoAt,
  frameIndexAt,
  selectedFrameRange,
  mediaSeekTime,
} from "./timing.js";
export function createPlayerController(editor) {
  const { state, video } = editor;
  let disposed = false,
    frameCallback = null,
    markVersion = 0;
  const listeners = [];
  const frameWaits = new Set();
  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  }
  function syncPlayButton() {
    const playing = !video.paused;
    $("play-button").innerHTML =
      `<svg class="icon"><use href="#i-${playing ? "pause" : "play"}"/></svg>`;
    bindAttribute("play-button", "aria-label", playing ? "Pause" : "Play");
  }

  function currentTime() {
    return state.seekTime ?? state.presentedTime ?? video.currentTime;
  }
  function updatePlayhead(time = currentTime()) {
    const frame = frameIndexAt(state.frameTimes, time);
    $("frame-back").disabled = !state.file || frame <= 0;
    $("frame-next").disabled =
      !state.file || frame < 0 || frame >= state.frameTimes.length - 1;
    $("current-time").textContent = formatTime(time);
    bindText(
      $("scrubber-time"),
      message("{value0} s", { value0: time.toFixed(3) }),
    );
    bindText(
      $("csv-time-readout"),
      state.data
        ? message("CSV {value0} s", {
            value0: dataTimeAt(time, state.offset, state.timeScale).toFixed(3),
          })
        : message("CSV —"),
    );
    editor.timeline.updatePlayhead(time);
    editor.videoInfo.updateFrame(time);
  }

  function stepFrame(direction, count = 1) {
    if (!state.frameTimes.length || !direction) return;
    video.pause();
    seek(
      adjacentFrameTime(
        state.frameTimes,
        currentTime(),
        Math.sign(direction) * Math.max(1, Math.round(count)),
      ),
    );
  }

  function seek(time) {
    if (disposed || !state.file || !Number.isFinite(time)) return;
    const value = clamp(time, 0, Math.max(0, state.duration - 0.00001));
    const mediaTime = mediaSeekTime(
      state.frameTimes,
      value,
      state.timing?.end ?? state.duration,
    );
    state.presentedTime = null;
    // Keep one seek in flight; rapid scrubbing coalesces to the latest requested position.
    if (video.seeking) state.seekTime = value;
    else if (Math.abs(video.currentTime - mediaTime) > 1e-7)
      video.currentTime = mediaTime;
    else {
      state.presentedTime =
        frameInfoAt(
          state.frameTimes,
          value,
          state.timing?.end ?? state.duration,
        )?.timestamp ?? value;
      editor.preview.render();
    }
    editor.timeline.ensureVisible(value);
    updatePlayhead(value);
  }

  async function pauseAtCurrentFrame() {
    const source = state.file;
    video.pause();
    // The canvas is the selected frame. Freeze it when pausing active playback.
    if (
      !video.seeking &&
      state.seekTime === null &&
      state.presentedTime !== null &&
      Math.abs(video.currentTime - state.presentedTime) > 1e-7
    )
      seek(state.presentedTime);
    if (video.seeking || state.seekTime !== null) {
      await new Promise((resolve, reject) => {
        const finish = () => {
          if (video.seeking || state.seekTime !== null) return;
          cleanup();
          resolve();
        };
        const fail = () => {
          cleanup();
          reject(
            new UserError(
              "The selected frame could not be loaded. Seek again, then retry alignment.",
            ),
          );
        };
        const cleanup = () => {
          clearTimeout(timer);
          frameWaits.delete(fail);
          video.removeEventListener("seeked", finish);
          for (const event of ["error", "emptied", "abort"])
            video.removeEventListener(event, fail);
        };
        const timer = setTimeout(fail, 10000);
        frameWaits.add(fail);
        // The seeked handler below starts the next queued seek before this listener runs.
        video.addEventListener("seeked", finish);
        for (const event of ["error", "emptied", "abort"])
          video.addEventListener(event, fail);
      });
    }
    if (disposed || !source || state.file !== source)
      throw new UserError(
        "The video changed during frame selection. Retry alignment.",
      );
    state.presentedTime =
      frameInfoAt(
        state.frameTimes,
        video.currentTime,
        state.timing?.end ?? state.duration,
      )?.timestamp ?? video.currentTime;
    editor.preview.render();
    updatePlayhead();
    return state.presentedTime;
  }

  listen(video, "seeked", () => {
    if (state.seekTime !== null) {
      const value = state.seekTime;
      state.seekTime = null;
      seek(value);
      return;
    }
    state.presentedTime =
      frameInfoAt(
        state.frameTimes,
        video.currentTime,
        state.timing?.end ?? state.duration,
      )?.timestamp ?? video.currentTime;
    editor.preview.render();
    updatePlayhead();
  });
  listen(video, "loadeddata", () => {
    state.presentedTime = null;
    editor.preview.render();
  });
  listen(video, "error", () => {
    if (state.file)
      editor.notice(
        "Playback failed for this video codec. Try a browser-supported H.264 MP4 or VP9 WebM file.",
        "error",
      );
  });
  listen(video, "play", syncPlayButton);
  listen(video, "pause", syncPlayButton);

  function selectedEndTime() {
    const range = selectedFrameRange(
      state.frameTimes,
      state.start,
      state.end,
      state.timing?.end ?? state.duration,
    );
    return range
      ? state.frameTimes[range.last - 1]
      : Math.max(state.start, state.end - 0.00001);
  }

  async function startPlayback() {
    if (disposed) return;
    const source = state.file;
    try {
      await video.play();
    } catch (error) {
      if (!disposed && state.file === source)
        editor.notice(
          message("Playback could not start: {value0}", {
            value0: error.message,
          }),
          "error",
        );
    }
  }

  function finishSelection(ended = false) {
    if (!state.file) return;
    if (state.loopSelection) {
      seek(state.start);
      if (ended) startPlayback();
    } else {
      video.pause();
      seek(selectedEndTime());
    }
  }

  listen(video, "ended", () => {
    // An ended event queued before an explicit seek must not change its selected frame.
    if (!video.ended || video.seeking || state.seekTime !== null) return;
    finishSelection(true);
    syncPlayButton();
  });
  // The media clock can run ahead of the displayed frame; only frame callbacks end a range.
  listen(video, "timeupdate", () => updatePlayhead());

  function requestFrame() {
    if (!disposed)
      frameCallback = video.requestVideoFrameCallback(onVideoFrame);
  }

  function onVideoFrame(_now, metadata) {
    frameCallback = null;
    if (disposed) return;
    // A callback already queued for the previous frame must not replace a pending seek.
    const stalePausedFrame =
      video.paused &&
      state.frameTimes.length &&
      frameIndexAt(state.frameTimes, metadata.mediaTime) !==
        frameIndexAt(state.frameTimes, video.currentTime);
    if (video.seeking || state.seekTime !== null || stalePausedFrame) {
      requestFrame();
      return;
    }
    // A callback queued before looping or seeking backwards cannot end the new range.
    if (
      !video.paused &&
      metadata.mediaTime >= state.end &&
      video.currentTime < state.end - 1e-7
    ) {
      requestFrame();
      return;
    }
    state.presentedTime = metadata.mediaTime;
    if (!video.paused && metadata.mediaTime >= state.end) {
      finishSelection();
    } else {
      editor.preview.render(metadata.mediaTime);
      updatePlayhead(metadata.mediaTime);
    }
    requestFrame();
  }
  if (!("requestVideoFrameCallback" in video))
    throw new UserError(
      "Frame-accurate preview requires a current Chrome, Edge, or Safari browser.",
    );
  requestFrame();

  async function togglePlay() {
    if (disposed || !state.file) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    if (
      currentTime() < state.start ||
      currentTime() >= selectedEndTime() - 1e-7
    )
      seek(state.start);
    await startPlayback();
  }
  listen($("play-button"), "click", togglePlay);
  function goToSelectedStart() {
    if (!state.file) return;
    video.pause();
    seek(state.start);
  }
  function goToSelectedEnd() {
    if (!state.file) return;
    video.pause();
    seek(selectedEndTime());
  }
  listen($("jump-start"), "click", goToSelectedStart);
  listen($("jump-alignment"), "click", () => {
    if (!state.file || !state.data) return;
    video.pause();
    seek(videoTimeAt(state.csvAnchor, state.offset, state.timeScale));
  });
  listen($("frame-back"), "click", () => stepFrame(-1));
  listen($("frame-next"), "click", () => stepFrame(1));
  listen($("scrubber"), "input", (event) => {
    video.pause();
    seek(Number(event.target.value));
  });
  function applyPreferences() {
    video.defaultPlaybackRate = video.playbackRate = Number($("playback-rate").value);
    const label = video.muted ? "Unmute preview" : "Mute preview";
    bindAttribute("mute-button", "aria-label", label);
    bindAttribute("mute-button", "title", label);
    $("mute-button").innerHTML =
      `<svg class="icon"><use href="#i-${video.muted ? "muted" : "volume"}"/></svg>`;
  }
  listen($("playback-rate"), "change", applyPreferences);
  listen($("mute-button"), "click", () => {
    video.muted = !video.muted;
    applyPreferences();
  });
  listen($("fullscreen"), "click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $("preview-stage").requestFullscreen();
    } catch {
      editor.notice(
        "Full screen is not available in this browser window.",
        "warning",
      );
    }
  });

  async function markFrame(edge) {
    if (!state.file || !state.frameTimes.length) return;
    const version = ++markVersion,
      source = state.file,
      timestamps = state.frameTimes,
      start = state.start,
      end = state.end;
    const current = () =>
      !disposed &&
      version === markVersion &&
      state.file === source &&
      state.frameTimes === timestamps &&
      state.start === start &&
      state.end === end;
    try {
      const time = await pauseAtCurrentFrame();
      if (!current()) return;
      const frame = frameInfoAt(
        timestamps,
        time,
        state.timing?.end ?? state.duration,
      );
      if (frame)
        editor.timeline.setTrim(
          edge,
          edge === "start" ? frame.timestamp : frame.end,
        );
    } catch (error) {
      if (current()) editor.notice(errorMessage(error), "error");
    }
  }
  const markIn = () => markFrame("start");
  const markOut = () => markFrame("end");
  for (const id of ["set-in", "frame-set-in"]) listen($(id), "click", markIn);
  for (const id of ["set-out", "frame-set-out"])
    listen($(id), "click", markOut);
  return {
    togglePlay,
    stepFrame,
    goToSelectedStart,
    goToSelectedEnd,
    markIn,
    markOut,
    seek,
    currentTime,
    pauseAtCurrentFrame,
    updatePlayhead,
    applyPreferences,
    dispose() {
      disposed = true;
      markVersion++;
      if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
      for (const fail of [...frameWaits]) fail();
      for (const remove of listeners) remove();
      video.pause();
    },
  };
}
