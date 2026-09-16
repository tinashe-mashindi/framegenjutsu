import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import { HttpError } from "./errors.js";
import { ensureDir } from "./paths.js";

const require = createRequire(import.meta.url);
const APOS = String.fromCharCode(39);

let cachedFfmpeg = null;
let cachedFfprobe = null;

function optionalRequire(id) {
  try {
    return require(id);
  } catch {
    return null;
  }
}

function staticFfmpegPath() {
  const value = optionalRequire("ffmpeg-static");
  if (typeof value === "string") return value;
  if (value && typeof value.default === "string") return value.default;
  return null;
}

function staticFfprobePath() {
  const value = optionalRequire("ffprobe-static");
  if (typeof value === "string") return value;
  if (value && typeof value.path === "string") return value.path;
  if (value && value.default && typeof value.default.path === "string") return value.default.path;
  return null;
}

function isExecutable(candidate) {
  if (!candidate || candidate === "ffmpeg" || candidate === "ffprobe") return true;
  try {
    fsSync.accessSync(candidate, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function runRaw(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        signal: opts.signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (opts.onStdout) opts.onStdout(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (opts.onStderr) opts.onStderr(text);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const tail = stderr.trim().slice(-1200) || stdout.trim().slice(-1200) || "no output";
      reject(new Error(bin + " exited with code " + code + (signal ? " (signal " + signal + ")" : "") + " :: " + tail));
    });
  });
}

export async function resolveFfmpeg() {
  if (cachedFfmpeg) return cachedFfmpeg;
  const candidates = [process.env.FFMPEG_PATH, staticFfmpegPath(), "ffmpeg"].filter(Boolean);
  for (const candidate of candidates) {
    if (!isExecutable(candidate)) continue;
    try {
      await runRaw(candidate, ["-version"]);
      cachedFfmpeg = candidate;
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  throw new HttpError(500, "ffmpeg was not found. Run 'npm install' to fetch the bundled static build, or install ffmpeg and set FFMPEG_PATH in .env.");
}

export async function resolveFfprobe() {
  if (cachedFfprobe) return cachedFfprobe;
  const candidates = [process.env.FFPROBE_PATH, staticFfprobePath(), "ffprobe"].filter(Boolean);
  for (const candidate of candidates) {
    if (!isExecutable(candidate)) continue;
    try {
      await runRaw(candidate, ["-version"]);
      cachedFfprobe = candidate;
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  throw new HttpError(500, "ffprobe was not found. Run 'npm install' to fetch the bundled static build, or install ffmpeg and set FFPROBE_PATH in .env.");
}

export async function ffmpeg(args, opts = {}) {
  const bin = await resolveFfmpeg();
  return runRaw(bin, ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], opts);
}

export async function ffprobeJson(file) {
  const bin = await resolveFfprobe();
  const { stdout } = await runRaw(bin, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  return JSON.parse(stdout || "{}");
}

function parseRate(rate) {
  if (!rate || typeof rate !== "string") return 0;
  const parts = rate.split("/");
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    return den ? num / den : 0;
  }
  const value = Number(rate);
  return Number.isFinite(value) ? value : 0;
}

export async function videoInfo(file) {
  const info = await ffprobeJson(file);
  const stream = (info.streams || []).find((s) => s.codec_type === "video");
  if (!stream) throw new HttpError(502, "Could not find a video stream in " + path.basename(file));
  const duration = Number(stream.duration || (info.format && info.format.duration) || 0);
  return {
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    duration,
    fps: parseRate(stream.avg_frame_rate || stream.r_frame_rate),
  };
}

export async function videoFrameCount(file) {
  try {
    const bin = await resolveFfprobe();
    const { stdout } = await runRaw(bin, [
      "-v", "error",
      "-select_streams", "v:0",
      "-count_frames",
      "-show_entries", "stream=nb_read_frames",
      "-of", "default=nokey=1:noprint_wrappers=1",
      file,
    ]);
    const counted = Number.parseInt(String(stdout).trim(), 10);
    if (Number.isFinite(counted) && counted > 0) return counted;
  } catch {
    /* fall back to duration x fps below */
  }
  const info = await videoInfo(file);
  if (info.fps > 0 && info.duration > 0) return Math.max(1, Math.round(info.fps * info.duration));
  return null;
}

export async function imageInfo(file) {
  const info = await ffprobeJson(file);
  const stream = (info.streams || []).find((s) => s.codec_type === "video");
  if (!stream || !stream.width || !stream.height) {
    throw new HttpError(400, "Could not read image dimensions from " + path.basename(file));
  }
  return { width: Number(stream.width), height: Number(stream.height) };
}

export async function normalizeImage(inputPath, outputPath, maxEdge = 0) {
  const filters = [];
  if (maxEdge > 0) {
    filters.push("scale=" + maxEdge + ":" + maxEdge + ":force_original_aspect_ratio=decrease");
  }
  // Round down to even dimensions: H.264 with yuv420p rejects odd sizes.
  filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  await ffmpeg(["-y", "-i", inputPath, "-frames:v", "1", "-vf", filters.join(","), outputPath]);
  return outputPath;
}

export async function conformFrame(inputPath, outputPath, width, height) {
  const filter = [
    "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease",
    "pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2:color=black",
    "setsar=1",
  ].join(",");
  await ffmpeg(["-y", "-i", inputPath, "-frames:v", "1", "-vf", filter, outputPath]);
  return outputPath;
}

export async function download(url, dest, opts = {}) {
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) {
    throw new HttpError(502, "Failed to download the generated video (" + res.status + " " + res.statusText + ")");
  }
  if (!res.body) throw new HttpError(502, "The generated video URL returned an empty body");
  await ensureDir(path.dirname(dest));
  await pipeline(Readable.fromWeb(res.body), fsSync.createWriteStream(dest));
  return dest;
}

export async function writeDataUri(dataUri, dest) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUri);
  if (!match) throw new HttpError(502, "Provider returned a malformed data URI");
  const payload = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
  await ensureDir(path.dirname(dest));
  await fs.writeFile(dest, payload);
  return dest;
}

/**
 * Pull exactly `count` frames out of a generated video, taking the frames that
 * sit evenly between the first and the last frame of the clip. Those two ends
 * are the anchor frames we conditioned the model on, so we drop them.
 */
export async function extractFrames(videoPath, count, outDir, log) {
  await fs.rm(outDir, { recursive: true, force: true });
  await ensureDir(outDir);

  const total = await videoFrameCount(videoPath);
  if (!total || total < 3) {
    throw new HttpError(502, "The generated video only has " + (total || 0) + " frame(s); at least 3 are needed to place in-between frames.");
  }

  const lastUsable = Math.max(1, total - 2);
  const indices = [];
  for (let i = 1; i <= count; i++) {
    let index = Math.round((i * (total - 1)) / (count + 1));
    if (index < 1) index = 1;
    if (index > lastUsable) index = lastUsable;
    indices.push(index);
  }

  await ffmpeg(["-y", "-i", videoPath, "-vsync", "0", path.join(outDir, "raw-%05d.png")]);

  const rawFiles = (await fs.readdir(outDir)).filter((name) => name.startsWith("raw-")).sort();
  if (!rawFiles.length) {
    throw new HttpError(502, "ffmpeg produced no frames from the generated video.");
  }

  const picked = [];
  for (let i = 0; i < indices.length; i++) {
    const wanted = Math.min(indices[i], rawFiles.length) - 1;
    const src = path.join(outDir, rawFiles[Math.max(0, wanted)]);
    const dst = path.join(outDir, "pick-" + String(i + 1).padStart(3, "0") + ".png");
    await fs.copyFile(src, dst);
    picked.push(dst);
  }

  if (log) {
    log("Extracted " + picked.length + " in-between frame(s) from " + total + " video frames.");
    if (count > lastUsable) {
      log("The clip was shorter than requested, so some in-between frames repeat.", "warn");
    }
  }
  return picked;
}

export async function makePreview(framePaths, workPath, outMp4, outGif, fps) {
  if (framePaths.length < 2) return { mp4: null, gif: null };
  const seqDir = path.join(workPath, "preview-seq");
  await fs.rm(seqDir, { recursive: true, force: true });
  await ensureDir(seqDir);
  for (let i = 0; i < framePaths.length; i++) {
    const name = "f-" + String(i + 1).padStart(5, "0") + ".png";
    await fs.copyFile(framePaths[i], path.join(seqDir, name));
  }
  const input = ["-framerate", String(fps), "-i", path.join(seqDir, "f-%05d.png")];
  const evenFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const result = { mp4: null, gif: null };

  try {
    await ffmpeg(["-y", ...input, "-vf", evenFilter, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outMp4]);
    result.mp4 = outMp4;
  } catch {
    /* preview is best effort */
  }
  try {
    await ffmpeg([
      "-y", ...input,
      "-filter_complex", "fps=" + fps + "," + evenFilter + ":flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
      "-loop", "0",
      outGif,
    ]);
    result.gif = outGif;
  } catch {
    /* preview is best effort */
  }
  return result;
}

export function concatQuote(file) {
  return APOS + file.split(APOS).join(APOS + "\\" + APOS + APOS) + APOS;
}
