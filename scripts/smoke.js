/**
 * End-to-end smoke test. Boots the real server in-process, generates three
 * synthetic anchor frames with ffmpeg, runs a full generation through the
 * offline providers, and asserts the files that land on disk.
 *
 *   npm run smoke
 */
import path from "node:path";
import fs from "node:fs/promises";

process.env.PORT = process.env.SMOKE_PORT || "8799";
process.env.HOST = "127.0.0.1";

const BASE = "http://127.0.0.1:" + process.env.PORT;

let failures = 0;

function check(ok, label, detail) {
  if (!ok) failures += 1;
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (detail ? " :: " + detail : ""));
}

async function ffmpegRun(args) {
  const { runRaw, resolveFfmpeg } = await import("../server/lib/media.js");
  const bin = await resolveFfmpeg();
  await runRaw(bin, ["-hide_banner", "-loglevel", "error", ...args]);
}

async function waitForServer(timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(BASE + "/api/health");
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error("server did not come up");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function dataUriOf(file) {
  const buffer = await fs.readFile(file);
  return "data:image/png;base64," + buffer.toString("base64");
}

async function runJobDetailed(body) {
  const res = await fetch(BASE + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || "generate rejected");
  const id = payload.jobId;

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const status = await (await fetch(BASE + "/api/jobs/" + id)).json();
    if (status.job.status === "done") return { result: status.job.result, logs: status.logs };
    if (status.job.status === "error") throw new Error(status.job.error);
  }
}

async function runJob(body) {
  return (await runJobDetailed(body)).result;
}

async function hashesOf(dir, names) {
  const { createHash } = await import("node:crypto");
  const out = [];
  for (const name of names) {
    const buffer = await fs.readFile(path.join(dir, name));
    out.push(createHash("sha256").update(buffer).digest("hex").slice(0, 12));
  }
  return out;
}

async function main() {
  console.log("");
  console.log("framegenjutsu smoke test");
  console.log("====================");

  const tmp = path.join(process.cwd(), ".tmp", "smoke");
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });

  const uploadsDir = path.join(process.cwd(), "projects", ".uploads");
  let uploadsBefore = new Set();
  try {
    uploadsBefore = new Set(await fs.readdir(uploadsDir));
  } catch {
    uploadsBefore = new Set();
  }

  console.log("Building synthetic anchor frames...");
  await ffmpegRun(["-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=1", "-frames:v", "1", path.join(tmp, "start.png")]);
  await ffmpegRun(["-y", "-f", "lavfi", "-i", "smptebars=size=320x240:rate=1", "-frames:v", "1", path.join(tmp, "middle.png")]);
  await ffmpegRun(["-y", "-f", "lavfi", "-i", "rgbtestsrc=size=320x240:rate=1", "-frames:v", "1", path.join(tmp, "end.png")]);

  const frames = {
    start: await dataUriOf(path.join(tmp, "start.png")),
    middle: await dataUriOf(path.join(tmp, "middle.png")),
    end: await dataUriOf(path.join(tmp, "end.png")),
  };

  await import("../server/index.js");
  const health = await waitForServer(20000);
  check(health.ok, "server booted with ffmpeg + ffprobe", health.ffmpeg);

  const providers = await (await fetch(BASE + "/api/providers")).json();
  check(Array.isArray(providers.providers) && providers.providers.length >= 4, "provider registry returned", providers.providers.length + " providers");
  check(providers.limits.MIN_IN_BETWEEN === 1 && providers.limits.MAX_IN_BETWEEN === 10, "in-between limits are 1..10");

  const scenes = [];

  /* ---- demo provider: numbering and manifest ---- */
  const demoScene = "smoke-demo-" + Date.now().toString(36);
  scenes.push(demoScene);
  console.log("");
  console.log("Run 1: demo provider, play-order numbering, 2 + 3 frames");
  const demo = await runJob({
    ...frames,
    scene: demoScene,
    provider: "demo",
    model: "pipeline-test",
    prompt: "smoke test",
    inBetweenA: 2,
    inBetweenB: 3,
    numbering: "play-order",
    fps: 8,
    makePreview: true,
  });

  check(demo.frames.length === 8, "8 frames produced (3 anchors + 5 generated)", String(demo.frames.length));
  check(demo.frames.map((f) => f.file).join(",") === "1.png,2.png,3.png,4.png,5.png,6.png,7.png,8.png", "play-order numbering is 1..8", demo.frames.map((f) => f.file).join(","));
  check(demo.frames[0].role === "start" && demo.frames[demo.frames.length - 1].role === "end", "first frame is the start anchor, last is the end anchor");
  check(demo.frames[3].role === "middle", "middle anchor sits at play index 4", demo.frames[3].file);
  check(demo.frames.filter((f) => f.role === "generated").length === 5, "5 generated frames");

  const demoDir = path.join(process.cwd(), "projects", demoScene);
  const onDisk = (await fs.readdir(demoDir)).sort();
  check(onDisk.includes("manifest.json"), "manifest.json written");
  check(onDisk.includes("preview.mp4") || onDisk.includes("preview.gif"), "a preview file was written", onDisk.filter((n) => n.startsWith("preview")).join(","));

  const manifest = JSON.parse(await fs.readFile(path.join(demoDir, "manifest.json"), "utf8"));
  check(manifest.anchors.start === "1.png" && manifest.anchors.middle === "4.png" && manifest.anchors.end === "8.png", "manifest records anchor positions", JSON.stringify(manifest.anchors));
  check(manifest.size.width === 320 && manifest.size.height === 240, "manifest records the frame size", manifest.size.width + "x" + manifest.size.height);

  const img = await fetch(BASE + "/api/files/scenes/" + demoScene + "/4.png");
  check(img.ok && img.headers.get("content-type").indexOf("image/png") === 0, "frames are served over HTTP", String(img.status));

  /* ---- anchors-first numbering ---- */
  const anchorScene = "smoke-anchors-" + Date.now().toString(36);
  scenes.push(anchorScene);
  console.log("");
  console.log("Run 2: anchors-first numbering");
  const anchorsFirst = await runJob({
    ...frames,
    scene: anchorScene,
    provider: "demo",
    model: "pipeline-test",
    prompt: "smoke test",
    inBetweenA: 1,
    inBetweenB: 1,
    numbering: "anchors-first",
    fps: 8,
    makePreview: false,
  });
  check(anchorsFirst.frames[0].file === "1.png" && anchorsFirst.frames[0].role === "start", "start anchor is 1.png");
  check(anchorsFirst.frames.some((f) => f.file === "2.png" && f.role === "middle"), "middle anchor is 2.png");
  check(anchorsFirst.frames.some((f) => f.file === "3.png" && f.role === "end"), "end anchor is 3.png");
  check(anchorsFirst.frames.filter((f) => f.role === "generated").every((f) => Number(f.file.replace(".png", "")) >= 4), "generated frames start at 4.png");

  /* ---- local ffmpeg interpolation ---- */
  const localScene = "smoke-local-" + Date.now().toString(36);
  scenes.push(localScene);
  console.log("");
  console.log("Run 3: local ffmpeg provider (real pixel interpolation)");
  const local = await runJob({
    ...frames,
    scene: localScene,
    provider: "local",
    model: "dissolve",
    prompt: "smoke test",
    inBetweenA: 3,
    inBetweenB: 2,
    numbering: "play-order",
    fps: 8,
    makePreview: true,
  });
  check(local.frames.length === 8, "local provider produced 8 frames", String(local.frames.length));
  const localDir = path.join(process.cwd(), "projects", localScene);
  const localFiles = await fs.readdir(localDir);
  check(localFiles.includes("1.png") && localFiles.includes("8.png"), "local frames written to disk");
  check(localFiles.includes("preview.mp4"), "local preview.mp4 written");

  const sizes = await Promise.all(["1.png", "4.png", "8.png"].map(async (name) => (await fs.stat(path.join(localDir, name))).size));
  check(sizes.every((size) => size > 0), "written frames are not empty", sizes.join("/"));

  const blendHashes = await hashesOf(localDir, ["2.png", "3.png", "4.png"]);
  check(new Set(blendHashes).size === 3, "dissolve produced 3 genuinely different in-between frames", blendHashes.join(","));
  const startHash = (await hashesOf(localDir, ["1.png"]))[0];
  check(blendHashes.every((hash) => hash !== startHash), "in-between frames differ from the start anchor");

  /* ---- local optical-flow interpolation ---- */
  const motionScene = "smoke-motion-" + Date.now().toString(36);
  scenes.push(motionScene);
  console.log("");
  console.log("Run 3b: local ffmpeg provider, optical-flow interpolation");
  const motionRun = await runJobDetailed({
    ...frames,
    scene: motionScene,
    provider: "local",
    model: "motion",
    prompt: "smoke test",
    inBetweenA: 3,
    inBetweenB: 2,
    numbering: "play-order",
    fps: 8,
    makePreview: false,
  });
  check(motionRun.result.frames.length === 8, "motion provider produced 8 frames", String(motionRun.result.frames.length));

  const motionDir = path.join(process.cwd(), "projects", motionScene);
  const motionHashes = await hashesOf(motionDir, ["2.png", "3.png", "4.png"]);
  check(new Set(motionHashes).size === 3, "optical flow produced 3 genuinely different in-between frames", motionHashes.join(","));

  const localLogs = motionRun.logs.map((entry) => entry.message).join("\n");
  check(localLogs.indexOf("motionInterpolate failed") === -1, "minterpolate ran without falling back");
  check(localLogs.indexOf("Falling back to anchor copies") === -1, "no anchor-copy fallback was needed");

  /* ---- cached clip reuse ---- */
  console.log("");
  console.log("Run 4: cached clip reuse");
  const reuse = await runJob({
    ...frames,
    scene: localScene,
    provider: "local",
    model: "dissolve",
    prompt: "smoke test",
    inBetweenA: 3,
    inBetweenB: 2,
    numbering: "play-order",
    fps: 8,
    makePreview: false,
    overwrite: true,
    reuseVideos: true,
  });
  check(reuse.frames.length === 8, "re-run with cached clips still produced 8 frames");

  /* ---- validation ---- */
  console.log("");
  console.log("Run 5: validation");
  const badCount = await fetch(BASE + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...frames, scene: "smoke-bad", provider: "demo", model: "pipeline-test", inBetweenA: 11, inBetweenB: 1 }),
  });
  check(badCount.status === 400, "11 in-between frames is rejected", String(badCount.status));

  const badName = await fetch(BASE + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...frames, scene: "../escape", provider: "demo", model: "pipeline-test", inBetweenA: 1, inBetweenB: 1 }),
  });
  check(badName.status === 400, "path-traversal scene name is rejected", String(badName.status));

  const traversal = await fetch(BASE + "/api/files/scenes/" + demoScene + "/..%2F..%2F..%2Fpackage.json");
  check(traversal.status >= 400, "file traversal through the scene route is blocked", String(traversal.status));

  const dotfile = await fetch(BASE + "/api/files/scenes/" + demoScene + "/.work/segment-A/frames/raw-00001.png");
  check(dotfile.status >= 400, "hidden .work paths are not served", String(dotfile.status));

  /* ---- video -> frames extraction (the path every AI provider uses) ---- */
  console.log("");
  console.log("Run 6: clip sampling, the path every AI endpoint uses");
  const clipPath = path.join(tmp, "clip.mp4");
  await ffmpegRun([
    "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", clipPath,
  ]);

  const media = await import("../server/lib/media.js");
  const total = await media.videoFrameCount(clipPath);
  check(total >= 70 && total <= 74, "ffprobe counted the clip frames", String(total));

  const extractDir = path.join(tmp, "extracted");
  const picked = await media.extractFrames(clipPath, 5, extractDir, null);
  check(picked.length === 5, "extractFrames returned exactly 5 frames", String(picked.length));

  const pickHashes = [];
  for (const file of picked) {
    const buffer = await fs.readFile(file);
    pickHashes.push((await import("node:crypto")).createHash("sha256").update(buffer).digest("hex").slice(0, 10));
  }
  check(new Set(pickHashes).size === 5, "sampled frames are all different", pickHashes.join(","));
  check(picked.every((file) => path.basename(file).startsWith("pick-")), "sampled frames are named pick-NNN.png");

  const conformed = path.join(tmp, "conformed.png");
  await media.conformFrame(picked[0], conformed, 320, 240);
  const conformInfo = await media.imageInfo(conformed);
  check(conformInfo.width === 320 && conformInfo.height === 240, "conformFrame letterboxes to the anchor size", conformInfo.width + "x" + conformInfo.height);

  const oversized = path.join(tmp, "oversized.mp4");
  await ffmpegRun(["-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=8", "-t", "0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", oversized]);
  let shortClipError = null;
  try {
    await media.extractFrames(oversized, 9, path.join(tmp, "short"), null);
  } catch (err) {
    shortClipError = err.message;
  }
  check(shortClipError === null, "a clip shorter than the request is clamped, not fatal", shortClipError || "no error");

  console.log("");
  for (const scene of scenes) {
    await fs.rm(path.join(process.cwd(), "projects", scene), { recursive: true, force: true });
  }
  await fs.rm(tmp, { recursive: true, force: true });

  let uploadsRemoved = 0;
  try {
    for (const name of await fs.readdir(uploadsDir)) {
      if (uploadsBefore.has(name)) continue;
      await fs.rm(path.join(uploadsDir, name), { force: true });
      uploadsRemoved += 1;
    }
  } catch {
    /* nothing to clean */
  }
  console.log("Cleaned up " + scenes.length + " smoke scenes and " + uploadsRemoved + " cached upload(s).");

  console.log("");
  if (failures) {
    console.log(failures + " check(s) FAILED");
    process.exit(1);
  }
  console.log("All checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("");
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
