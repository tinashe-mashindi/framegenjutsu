import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { HttpError } from "./errors.js";
import { ensureDir, sceneDir, workDir, projectsDir, assertSceneName, WORK_DIR_NAME } from "./paths.js";
import {
  normalizeImage,
  imageInfo,
  download,
  extractFrames,
  conformFrame,
  makePreview,
  writeDataUri,
} from "./media.js";
import { config } from "../config.js";
import { resolveSelection } from "../providers/index.js";
import { logLine, setStage } from "./jobs.js";

const MIN_IN_BETWEEN = 1;
const MAX_IN_BETWEEN = 10;

function uploadsDir() {
  return path.join(projectsDir(), ".uploads");
}

function runwayRatio(width, height) {
  if (height > width) return "720:1280";
  if (Math.abs(width / height - 1) < 0.08) return "960:960";
  return "1280:720";
}

function simpleRatio(width, height) {
  if (height > width * 1.1) return "9:16";
  if (width > height * 1.1) return "16:9";
  return "1:1";
}

function clampCount(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new HttpError(400, label + " must be a number between " + MIN_IN_BETWEEN + " and " + MAX_IN_BETWEEN);
  if (parsed < MIN_IN_BETWEEN || parsed > MAX_IN_BETWEEN) {
    throw new HttpError(400, label + " must be between " + MIN_IN_BETWEEN + " and " + MAX_IN_BETWEEN);
  }
  return parsed;
}

function extensionFor(mime) {
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/bmp") return ".bmp";
  if (mime === "image/avif") return ".avif";
  return ".png";
}

async function dataUriToPng(dataUri, role) {
  if (typeof dataUri !== "string" || !dataUri.startsWith("data:image/")) {
    throw new HttpError(400, "The " + role + " frame must be an uploaded image");
  }
  const mimeMatch = /^data:([^;,]+)/.exec(dataUri);
  const mime = mimeMatch ? mimeMatch[1].toLowerCase() : "image/png";
  const dir = uploadsDir();
  await ensureDir(dir);
  const id = crypto.randomUUID().slice(0, 8);
  // ".src" keeps the raw upload distinct from the normalised PNG, otherwise
  // ffmpeg refuses to read and write the same path.
  const raw = path.join(dir, id + "-" + role + ".src" + extensionFor(mime));
  const png = path.join(dir, id + "-" + role + ".png");
  await writeDataUri(dataUri, raw);
  try {
    await normalizeImage(raw, png, config.maxEdge);
  } catch (err) {
    throw new HttpError(400, "Could not read the " + role + " frame (" + (err && err.message ? err.message : String(err)) + ")");
  } finally {
    await fs.rm(raw, { force: true });
  }
  return png;
}

async function fileToDataUri(file) {
  const buffer = await fs.readFile(file);
  return "data:image/png;base64," + buffer.toString("base64");
}

function publicUrlFor(file) {
  if (!config.publicBaseUrl) return null;
  const dir = uploadsDir();
  const relative = path.relative(dir, file);
  if (relative.startsWith("..")) return null;
  return config.publicBaseUrl + "/api/files/uploads/" + relative.split(path.sep).join("/");
}

function makeLogger(job, segment) {
  const prefix = segment ? "[seg " + segment + "] " : "";
  let lastTick = 0;
  return {
    log(message, level) {
      logLine(job, prefix + message, level || "info");
    },
    progressTick(text) {
      const now = Date.now();
      if (now - lastTick < 8000) return;
      lastTick = now;
      const line = String(text || "").trim().split("\n").filter(Boolean).pop();
      if (line) logLine(job, prefix + line.slice(0, 200), "debug");
    },
  };
}

async function renderSegment(job, opts) {
  const { provider, model, segment, first, last, count, ctxBase } = opts;
  const segDir = path.join(workDir(opts.scene), "segment-" + segment);
  await ensureDir(segDir);
  const logger = makeLogger(job, segment);

  const videoPath = path.join(segDir, "clip.mp4");
  const reuse = opts.reuseVideos && await exists(videoPath);

  const ctx = {
    ...ctxBase,
    providerId: provider.id,
    model,
    count,
    first,
    last,
    workDir: segDir,
    log: logger.log,
    progressTick: logger.progressTick,
  };

  let produced;

  if (reuse) {
    logger.log("Reusing the cached clip from a previous run.");
    produced = { videoPath };
  } else {
    logger.log("Calling " + provider.label + " / " + model.label + " for " + count + " in-between frame(s).");
    produced = await provider.render(ctx);
  }

  if (produced.framePaths && produced.framePaths.length) {
    return produced.framePaths;
  }
  if (produced.frames && produced.frames.length) {
    const paths = [];
    for (let i = 0; i < produced.frames.length; i++) {
      const dest = path.join(segDir, "inline-" + String(i + 1).padStart(3, "0") + ".png");
      await fs.writeFile(dest, produced.frames[i]);
      paths.push(dest);
    }
    return paths;
  }

  let clip = produced.videoPath || null;
  if (!clip && produced.videoUrl) {
    logger.log("Downloading the generated clip.");
    clip = await download(produced.videoUrl, videoPath, { signal: ctx.signal });
  }
  if (!clip) {
    throw new HttpError(502, provider.label + " returned neither a clip nor frames.");
  }

  logger.log("Sampling " + count + " frame(s) out of the clip.");
  return extractFrames(clip, count, path.join(segDir, "frames"), logger.log);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function buildSequence(anchors, framesA, framesB) {
  const sequence = [];
  sequence.push({ role: "start", segment: null, src: anchors.start });
  framesA.forEach((src) => sequence.push({ role: "generated", segment: "A", src }));
  sequence.push({ role: "middle", segment: null, src: anchors.middle });
  framesB.forEach((src) => sequence.push({ role: "generated", segment: "B", src }));
  sequence.push({ role: "end", segment: null, src: anchors.end });
  return sequence;
}

function assignNames(sequence, numbering) {
  if (numbering === "anchors-first") {
    const anchorOrder = ["start", "middle", "end"];
    let anchorIndex = 0;
    const generated = [];
    for (const entry of sequence) {
      if (entry.role === "generated") generated.push(entry);
      else entry.file = anchorIndex++ + 1 + ".png";
    }
    generated.forEach((entry, index) => {
      entry.file = anchorOrder.length + index + 1 + ".png";
    });
    return;
  }
  sequence.forEach((entry, index) => {
    entry.file = index + 1 + ".png";
  });
}

/**
 * Validates and normalises a generation request. Throws HttpError(400) so the
 * HTTP layer can reject bad input before anything is queued - the job runner
 * calls this again on the plan it is handed.
 */
export function parseRequest(input) {
  const request = input || {};
  const scene = assertSceneName(String(request.scene || "").trim());

  const provider = String(request.provider || "").trim();
  if (!provider) throw new HttpError(400, "Pick an AI endpoint before generating.");

  const model = String(request.model || "").trim();
  const inBetweenA = clampCount(request.inBetweenA, "Frames between the start and middle frame");
  const inBetweenB = clampCount(request.inBetweenB, "Frames between the middle and end frame");

  for (const role of ["start", "middle", "end"]) {
    if (typeof request[role] !== "string" || request[role].indexOf("data:image/") !== 0) {
      throw new HttpError(400, "Upload a " + role + " frame before generating.");
    }
  }

  let duration = null;
  if (request.duration !== undefined && request.duration !== null && request.duration !== "") {
    const parsed = Number.parseInt(request.duration, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 30) {
      throw new HttpError(400, "Clip length must be between 1 and 30 seconds.");
    }
    duration = parsed;
  }

  let fps = config.previewFps;
  if (request.fps !== undefined && request.fps !== null && request.fps !== "") {
    const parsed = Number.parseInt(request.fps, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60) {
      throw new HttpError(400, "Preview fps must be between 1 and 60.");
    }
    fps = parsed;
  }

  return {
    scene,
    provider,
    model,
    prompt: String(request.prompt || "").trim(),
    negativePrompt: String(request.negativePrompt || "").trim(),
    inBetweenA,
    inBetweenB,
    numbering: request.numbering === "anchors-first" ? "anchors-first" : "play-order",
    fps,
    duration,
    resolution: request.resolution || "720p",
    overwrite: Boolean(request.overwrite),
    reuseVideos: Boolean(request.reuseVideos),
    withPreview: request.makePreview !== false,
    start: request.start,
    middle: request.middle,
    end: request.end,
  };
}

export async function runGeneration(job, plan) {
  const {
    scene, inBetweenA, inBetweenB, numbering, fps, overwrite,
    reuseVideos, withPreview, resolution, prompt, negativePrompt,
  } = plan;

  const { provider, model } = await resolveSelection(plan.provider, plan.model);
  const duration = plan.duration || (model.defaults && model.defaults.duration) || 5;

  const dir = sceneDir(scene);
  const alreadyThere = await exists(dir);
  if (alreadyThere && !overwrite) {
    throw new HttpError(409, "A scene named '" + scene + "' already exists. Tick 'Overwrite' to replace it.");
  }
  if (model.requiresPublicUrl && !config.publicBaseUrl) {
    throw new HttpError(400, model.label + " needs publicly reachable image URLs. Set PUBLIC_BASE_URL in .env (for example a tunnel pointing at this server) and restart.");
  }

  logLine(job, "Scene '" + scene + "' with " + provider.label + " / " + model.label);
  setStage(job, "preparing", 5);

  const work = workDir(scene);
  await ensureDir(work);

  logLine(job, "Decoding the three anchor frames.");
  const [startPng, middlePng, endPng] = await Promise.all([
    dataUriToPng(plan.start, "start"),
    dataUriToPng(plan.middle, "middle"),
    dataUriToPng(plan.end, "end"),
  ]);

  const geometry = await imageInfo(startPng);
  const width = geometry.width;
  const height = geometry.height;

  const middleInfo = await imageInfo(middlePng);
  const endInfo = await imageInfo(endPng);
  if (middleInfo.width !== width || middleInfo.height !== height) {
    logLine(job, "The middle frame is " + middleInfo.width + "x" + middleInfo.height + " but the start frame is " + width + "x" + height + ". Output frames are letterboxed to " + width + "x" + height + " so the sequence stays uniform.", "warn");
  }
  if (endInfo.width !== width || endInfo.height !== height) {
    logLine(job, "The end frame is " + endInfo.width + "x" + endInfo.height + " but the start frame is " + width + "x" + height + ". Output frames are letterboxed to " + width + "x" + height + " so the sequence stays uniform.", "warn");
  }

  const ctxBase = {
    prompt: prompt || "Smooth, believable motion that continues naturally from the first frame into the last frame.",
    negativePrompt,
    duration,
    fps,
    resolution,
    aspectRatio: runwayRatio(width, height),
    aspectRatioSimple: simpleRatio(width, height),
    signal: job.abortController ? job.abortController.signal : undefined,
  };

  const start = { path: startPng, dataUrl: await fileToDataUri(startPng), publicUrl: publicUrlFor(startPng) };
  const middle = { path: middlePng, dataUrl: await fileToDataUri(middlePng), publicUrl: publicUrlFor(middlePng) };
  const end = { path: endPng, dataUrl: await fileToDataUri(endPng), publicUrl: publicUrlFor(endPng) };

  setStage(job, "generating", 15);
  if (!model.supportsEndFrame) {
    logLine(job, model.label + " only conditions on a start frame, so segment ends will not line up exactly with your anchor.", "warn");
  }
  logLine(job, "Rendering both segments in parallel (" + inBetweenA + " + " + inBetweenB + " in-between frames).");

  const [framesA, framesB] = await Promise.all([
    renderSegment(job, { job, provider, model, scene, segment: "A", first: start, last: middle, count: inBetweenA, ctxBase, reuseVideos }),
    renderSegment(job, { job, provider, model, scene, segment: "B", first: middle, last: end, count: inBetweenB, ctxBase, reuseVideos }),
  ]);

  setStage(job, "assembling", 80);
  logLine(job, "Assembling " + (framesA.length + framesB.length + 3) + " frames in play order.");

  const sequence = buildSequence({ start: startPng, middle: middlePng, end: endPng }, framesA, framesB);
  assignNames(sequence, numbering);

  await ensureDir(dir);
  const frames = [];
  for (let index = 0; index < sequence.length; index++) {
    const entry = sequence[index];
    const dest = path.join(dir, entry.file);
    const isAnchor = entry.role !== "generated";
    if (isAnchor) {
      const info = await imageInfo(entry.src);
      if (info.width === width && info.height === height) {
        await fs.copyFile(entry.src, dest);
      } else {
        await conformFrame(entry.src, dest, width, height);
      }
    } else {
      await conformFrame(entry.src, dest, width, height);
    }
    frames.push({
      file: entry.file,
      role: entry.role,
      segment: entry.segment,
      playIndex: index,
      url: "/api/files/scenes/" + encodeURIComponent(scene) + "/" + entry.file,
    });
  }

  const anchors = {};
  for (const entry of frames) {
    if (entry.role !== "generated") anchors[entry.role] = entry.file;
  }

  let previews = { mp4: null, gif: null };
  if (withPreview) {
    logLine(job, "Building preview files at " + fps + " fps.");
    try {
      const ordered = frames.map((frame) => path.join(dir, frame.file));
      const built = await makePreview(ordered, work, path.join(dir, "preview.mp4"), path.join(dir, "preview.gif"), fps);
      previews = {
        mp4: built.mp4 ? "/api/files/scenes/" + encodeURIComponent(scene) + "/preview.mp4" : null,
        gif: built.gif ? "/api/files/scenes/" + encodeURIComponent(scene) + "/preview.gif" : null,
      };
    } catch (err) {
      logLine(job, "Preview build skipped: " + (err && err.message ? err.message : String(err)), "warn");
    }
  }

  const manifest = {
    scene,
    createdAt: new Date().toISOString(),
    provider: provider.id,
    providerLabel: provider.label,
    model: model.id,
    modelLabel: model.label,
    prompt: ctxBase.prompt,
    negativePrompt,
    numbering,
    duration,
    fps,
    size: { width, height },
    inBetweens: { segmentA: inBetweenA, segmentB: inBetweenB },
    anchors,
    frames,
    previews,
  };
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  await fs.rm(path.join(dir, WORK_DIR_NAME, "preview-seq"), { recursive: true, force: true });

  return {
    scene,
    dir: path.relative(projectsDir(), dir),
    provider: provider.id,
    model: model.id,
    frames,
    anchors,
    previews,
    manifestUrl: "/api/files/scenes/" + encodeURIComponent(scene) + "/manifest.json",
    inBetweens: manifest.inBetweens,
    size: manifest.size,
  };
}

export const limits = { MIN_IN_BETWEEN, MAX_IN_BETWEEN };
