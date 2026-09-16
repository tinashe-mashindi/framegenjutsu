import fs from "node:fs/promises";
import path from "node:path";
import { ffmpeg, imageInfo } from "../lib/media.js";
import { ensureDir } from "../lib/paths.js";

function scalePad(width, height) {
  return [
    "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease",
    "pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2:color=black",
    "setsar=1",
  ].join(",");
}

function tail(paths, count) {
  // 1-based frame files: drop the first (the start anchor) and keep the next count.
  return paths.slice(1, 1 + count);
}

async function listFrames(dir, prefix) {
  const names = (await fs.readdir(dir)).filter((name) => name.startsWith(prefix)).sort();
  return names.map((name) => path.join(dir, name));
}

const SOURCE_FPS = 8;
const ANCHOR_COPIES = 2;

function splitLabels(prefix, n) {
  const labels = [];
  for (let i = 0; i < n; i++) labels.push("[" + prefix + i + "]");
  return labels;
}

/**
 * Optical-flow interpolation with ffmpeg's minterpolate.
 *
 * Two things matter for this to work at all:
 *   1. The source clip must run at a sane frame rate. At 1 fps minterpolate
 *      silently emits zero frames.
 *   2. minterpolate needs neighbours around the transition, so each anchor is
 *      repeated. A bare [A, B] clip emits nothing either.
 *
 * With a [A,A,B,B] clip and a target rate of SOURCE_FPS * (count + 1),
 * minterpolate subdivides the single A->B interval into count + 1 steps and
 * hands back count + 2 frames: the two ends plus the in-betweens.
 */
async function motionInterpolate(ctx, outDir) {
  const info = await imageInfo(ctx.first.path);
  const frames = ctx.count + 2;
  const targetFps = SOURCE_FPS * (ctx.count + 1);
  const size = scalePad(info.width, info.height);
  const clip = path.join(outDir, "anchors.mp4");

  const aLabels = splitLabels("a", ANCHOR_COPIES);
  const bLabels = splitLabels("b", ANCHOR_COPIES);
  const filter = [
    "[0:v]" + size + ",format=yuv420p,split=" + ANCHOR_COPIES + aLabels.join(""),
    "[1:v]" + size + ",format=yuv420p,split=" + ANCHOR_COPIES + bLabels.join(""),
    aLabels.join("") + bLabels.join("") + "concat=n=" + ANCHOR_COPIES * 2 + ":v=1[v]",
  ].join(";");

  await ffmpeg([
    "-y",
    "-framerate", String(SOURCE_FPS), "-i", ctx.first.path,
    "-framerate", String(SOURCE_FPS), "-i", ctx.last.path,
    "-filter_complex", filter,
    "-map", "[v]",
    "-r", String(SOURCE_FPS),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    clip,
  ]);

  await ffmpeg([
    "-y",
    "-i", clip,
    "-vf", "minterpolate=fps=" + targetFps + ":mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1",
    "-frames:v", String(frames),
    path.join(outDir, "interp-%05d.png"),
  ]);

  const produced = await listFrames(outDir, "interp-");
  if (produced.length < ctx.count + 2) {
    throw new Error("minterpolate produced " + produced.length + " frame(s), expected " + (ctx.count + 2));
  }
  return tail(produced, ctx.count);
}

async function dissolveInterpolate(ctx, outDir) {
  const info = await imageInfo(ctx.first.path);
  const frames = ctx.count + 2;
  const fps = ctx.count + 1;
  // A fade of "span" seconds at "fps" frames per second yields frames+1 frames
  // (t = 0 .. span). We need frames+2 so we can drop the first and the last.
  const span = ((ctx.count + 2) / (ctx.count + 1)).toFixed(4);
  const size = scalePad(info.width, info.height);

  await ffmpeg([
    "-y",
    "-loop", "1", "-framerate", String(fps), "-t", span, "-i", ctx.first.path,
    "-loop", "1", "-framerate", String(fps), "-t", span, "-i", ctx.last.path,
    "-filter_complex",
    "[0:v]" + size + ",format=yuv420p[a];[1:v]" + size + ",format=yuv420p[b];" +
      "[a][b]xfade=transition=fade:duration=" + span + ":offset=0[v]",
    "-map", "[v]",
    "-frames:v", String(frames),
    path.join(outDir, "blend-%05d.png"),
  ]);

  const produced = await listFrames(outDir, "blend-");
  if (produced.length < ctx.count + 2) {
    throw new Error("xfade produced " + produced.length + " frame(s), expected " + (ctx.count + 2));
  }
  return tail(produced, ctx.count);
}

async function anchorCopies(ctx, outDir) {
  const picked = [];
  for (let i = 1; i <= ctx.count; i++) {
    const source = i * 2 <= ctx.count ? ctx.first.path : ctx.last.path;
    const dest = path.join(outDir, "copy-" + String(i).padStart(3, "0") + ".png");
    await fs.copyFile(source, dest);
    picked.push(dest);
  }
  ctx.log("Falling back to anchor copies - the in-betweens repeat your input frames.", "warn");
  return picked;
}

export default {
  id: "local",
  label: "Local (offline)",
  homepage: "https://ffmpeg.org",
  keyEnv: [],
  requiresKey: false,
  note: "Runs entirely on your machine with ffmpeg: no API key, no upload, no cost. Best effort only - optical flow needs visible motion between the two anchors and invents nothing, so use it for cleanup passes or when you have no key at all.",
  models: [
    {
      id: "motion",
      label: "Motion interpolation (optical flow)",
      strategy: "sequence",
      supportsEndFrame: true,
      note: "ffmpeg minterpolate: estimates real motion between the two anchors.",
    },
    {
      id: "dissolve",
      label: "Cross-dissolve",
      strategy: "sequence",
      supportsEndFrame: true,
      note: "Simple fade between the anchors. Very fast and completely deterministic.",
    },
  ],

  async render(ctx) {
    const outDir = path.join(ctx.workDir, "local-" + ctx.model.id);
    await fs.rm(outDir, { recursive: true, force: true });
    await ensureDir(outDir);

    const attempts = ctx.model.id === "motion"
      ? [motionInterpolate, dissolveInterpolate, anchorCopies]
      : [dissolveInterpolate, anchorCopies];

    let lastError = null;
    for (const attempt of attempts) {
      try {
        ctx.log("Local: " + ctx.model.id + " -> " + attempt.name);
        const framePaths = await attempt(ctx, outDir);
        return { framePaths };
      } catch (err) {
        lastError = err;
        ctx.log("Local " + attempt.name + " failed (" + (err && err.message ? err.message : String(err)) + "), trying the next strategy.", "warn");
        await fs.rm(outDir, { recursive: true, force: true });
        await ensureDir(outDir);
      }
    }
    throw lastError || new Error("Local interpolation failed");
  },
};
