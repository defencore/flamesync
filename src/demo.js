import { parseCSV, clamp } from "./data.js";

export function demoCSV() {
  const rows = ["time_ms;thrust;pressure"];
  for (let i = 0; i <= 330; i++) {
    const t = i / 60;
    const onset = clamp((t - 0.6) / 0.13, 0, 1);
    const tail = clamp((4.65 - t) / 0.65, 0, 1);
    const force = Math.max(
      0,
      onset *
        tail *
        (430 +
          210 * Math.exp(-(((t - 0.86) / 0.19) ** 2)) -
          28 * t +
          6 * Math.sin(t * 81)),
    );
    const pressure = Math.max(
      0,
      onset *
        tail *
        (26 +
          10 * Math.exp(-(((t - 0.86) / 0.23) ** 2)) -
          1.1 * t +
          0.3 * Math.sin(t * 51)),
    );
    rows.push(
      `${(t * 1000).toFixed(3)};${force.toFixed(3)};${pressure.toFixed(3)}`,
    );
  }
  return rows.join("\n");
}

export function drawDemo(ctx, w, h, time) {
  ctx.save();
  ctx.scale(w / 960, h / 540);
  const bg = ctx.createLinearGradient(0, 0, 0, 540);
  bg.addColorStop(0, "#253536");
  bg.addColorStop(1, "#121e22");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 960, 540);
  ctx.strokeStyle = "#7283770c";
  ctx.lineWidth = 1;
  for (let x = 0; x < 960; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 430);
    ctx.stroke();
  }
  for (let y = 0; y < 430; y += 48) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(960, y);
    ctx.stroke();
  }
  ctx.fillStyle = "#0e191b";
  ctx.fillRect(0, 360, 960, 180);
  ctx.fillStyle = "#83928a";
  ctx.font = "10px monospace";
  ctx.fillText("DEMO FOOTAGE / SYNTHETIC STATIC FIRE", 30, 34);
  ctx.fillStyle = "#dce4d8";
  ctx.font = "16px monospace";
  ctx.fillText("TEST STAND 01", 30, 60);
  ctx.textAlign = "right";
  ctx.fillStyle = "#8da08e";
  ctx.font = "11px monospace";
  ctx.fillText(`CAM 01  /  ${time.toFixed(3)} s`, 930, 34);
  ctx.textAlign = "left";
  // The synthetic test stand is deliberately labeled as demonstration footage.
  ctx.fillStyle = "#485858";
  ctx.fillRect(112, 254, 340, 12);
  ctx.fillRect(145, 264, 17, 96);
  ctx.fillRect(390, 264, 17, 96);
  ctx.fillStyle = "#65736b";
  ctx.fillRect(121, 354, 65, 8);
  ctx.fillRect(365, 354, 65, 8);
  const body = ctx.createLinearGradient(0, 196, 0, 241);
  body.addColorStop(0, "#71827a");
  body.addColorStop(0.3, "#bcc4af");
  body.addColorStop(0.7, "#6b7d74");
  body.addColorStop(1, "#3e5350");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.roundRect(166, 191, 263, 55, 8);
  ctx.fill();
  ctx.fillStyle = "#4b5b55";
  ctx.fillRect(192, 185, 11, 67);
  ctx.fillRect(373, 185, 11, 67);
  ctx.fillStyle = "#1c2d2c";
  ctx.beginPath();
  ctx.moveTo(429, 201);
  ctx.lineTo(454, 193);
  ctx.lineTo(454, 245);
  ctx.lineTo(429, 237);
  ctx.fill();
  ctx.strokeStyle = "#96a68c";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(177, 190);
  ctx.lineTo(177, 155);
  ctx.lineTo(130, 143);
  ctx.lineTo(128, 80);
  ctx.stroke();
  ctx.fillStyle = "#9aa78f";
  ctx.font = "9px monospace";
  ctx.fillText("LOAD CELL", 110, 126);
  ctx.fillText("PRESSURE TAP", 200, 170);
  const data = (parseCSVCache ??= parseCSV(demoCSV()));
  const local = time - 1;
  const nearest = data.points[Math.round(clamp(local * 60, 0, 330))];
  const strength = nearest.thrust / 640;
  if (strength > 0.01) {
    const length = 110 + strength * 290 + Math.sin(time * 81) * 12;
    const glow = ctx.createRadialGradient(530, 220, 5, 560, 220, 245);
    glow.addColorStop(0, `rgba(255,163,65,${strength * 0.3})`);
    glow.addColorStop(1, "#ff9b3900");
    ctx.fillStyle = glow;
    ctx.fillRect(350, 15, 600, 400);
    for (let layer = 0; layer < 3; layer++) {
      ctx.fillStyle = ["#f89539", "#ffc269", "#fff2c7"][layer];
      ctx.globalAlpha = [0.65, 0.9, 1][layer];
      const len = length * [1, 0.75, 0.42][layer];
      const spread = [25, 17, 9][layer] * strength;
      ctx.beginPath();
      ctx.moveTo(454, 206);
      for (let i = 0; i <= 30; i++) {
        const x = i / 30;
        ctx.lineTo(
          454 + len * x,
          218 - (1 - x) * (10 + spread * Math.sin(x * 11 + time * 50) ** 2),
        );
      }
      for (let i = 30; i >= 0; i--) {
        const x = i / 30;
        ctx.lineTo(
          454 + len * x,
          220 + (1 - x) * (10 + spread * Math.cos(x * 13 + time * 63) ** 2),
        );
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = "#728478";
  ctx.font = "9px monospace";
  ctx.fillText("SIMULATED TELEMETRY / NOT A REAL TEST", 30, 391);
  ctx.restore();
}
let parseCSVCache;

export async function createDemo(progress = () => {}) {
  const {
    Output,
    BufferTarget,
    WebMOutputFormat,
    CanvasSource,
    AudioSampleSource,
    AudioSample,
    canEncodeAudio,
  } = await import("mediabunny");
  const canvas = new OffscreenCanvas(960, 540);
  const ctx = canvas.getContext("2d");
  const target = new BufferTarget();
  const output = new Output({ target, format: new WebMOutputFormat() });
  const source = new CanvasSource(canvas, { codec: "vp9", bitrate: 2_000_000 });
  output.addVideoTrack(source, { frameRate: 24 });
  const withAudio = await canEncodeAudio("opus");
  const audio = withAudio
    ? new AudioSampleSource({ codec: "opus", bitrate: 96_000 })
    : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();
  for (let i = 0; i < 192; i++) {
    const t = i / 24;
    drawDemo(ctx, 960, 540, t);
    await source.add(t, 1 / 24);
    if (audio) {
      const wave = new Float32Array(2000);
      for (let j = 0; j < wave.length; j++) {
        const at = t + j / 48000;
        const env =
          clamp((at - 1.6) / 0.15, 0, 1) * clamp((5.65 - at) / 0.6, 0, 1);
        wave[j] =
          env *
          (0.025 * Math.sin(at * 110 * Math.PI * 2) +
            0.025 * Math.sin(at * 347 * Math.PI * 2));
      }
      const sample = new AudioSample({
        data: wave,
        format: "f32-planar",
        numberOfChannels: 1,
        sampleRate: 48000,
        timestamp: t,
      });
      await audio.add(sample);
      sample.close();
    }
    if (i % 12 === 0) progress(i / 192);
  }
  source.close();
  audio?.close();
  await output.finalize();
  return {
    file: new File([target.buffer], "static-fire-demo.webm", {
      type: "video/webm",
    }),
    csv: demoCSV(),
  };
}
