import path from "node:path";
import fs from "node:fs/promises";
import express from "express";
import { config } from "./config.js";
import { PUBLIC_DIR, projectsDir, listScenes, sceneDir, assertSceneName } from "./lib/paths.js";
import { HttpError, toErrorPayload } from "./lib/errors.js";
import {
  createJob,
  getJob,
  publicJob,
  subscribe,
  startJob,
  finishJob,
  failJob,
  logLine,
  setStage,
} from "./lib/jobs.js";
import { listProviders, writeOverrideTemplate, resolveSelection } from "./providers/index.js";
import { runGeneration, parseRequest, limits } from "./lib/pipeline.js";
import { resolveFfmpeg, resolveFfprobe } from "./lib/media.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: config.jsonLimit }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    if (rel === "") return target;
    throw new HttpError(403, "Path escapes the project directory");
  }
  const parts = rel.split(path.sep);
  if (parts.some((part) => part.startsWith("."))) {
    throw new HttpError(403, "Hidden paths are not served");
  }
  return target;
}

/* ---------------------------------------------------------------- api */

app.get("/api/health", async (req, res) => {
  let ffmpeg = null;
  let ffprobe = null;
  try {
    ffmpeg = await resolveFfmpeg();
  } catch (err) {
    ffmpeg = null;
  }
  try {
    ffprobe = await resolveFfprobe();
  } catch (err) {
    ffprobe = null;
  }
  res.json({
    ok: Boolean(ffmpeg && ffprobe),
    version: "1.0.0",
    ffmpeg: ffmpeg ? path.basename(ffmpeg) : null,
    ffprobe: ffprobe ? path.basename(ffprobe) : null,
    projectsDir: projectsDir(),
    publicBaseUrl: config.publicBaseUrl || null,
  });
});

app.get("/api/providers", async (req, res, next) => {
  try {
    const providers = await listProviders();
    res.json({
      providers,
      limits,
      defaults: {
        fps: config.previewFps,
        maxEdge: config.maxEdge,
        publicBaseUrl: config.publicBaseUrl || null,
        hasPublicBaseUrl: Boolean(config.publicBaseUrl),
      },
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/scenes", async (req, res, next) => {
  try {
    res.json({ scenes: await listScenes() });
  } catch (err) {
    next(err);
  }
});

app.get("/api/scenes/:scene", async (req, res, next) => {
  try {
    const name = assertSceneName(req.params.scene);
    const file = path.join(sceneDir(name), "manifest.json");
    const text = await fs.readFile(file, "utf8");
    res.type("application/json").send(text);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      next(new HttpError(404, "No manifest for that scene"));
      return;
    }
    next(err);
  }
});

app.delete("/api/scenes/:scene", async (req, res, next) => {
  try {
    const name = assertSceneName(req.params.scene);
    await fs.rm(sceneDir(name), { recursive: true, force: true });
    res.json({ ok: true, scene: name });
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- jobs */

const queue = [];
let queueBusy = false;

function drainQueue() {
  if (queueBusy) return;
  const task = queue.shift();
  if (!task) return;
  queueBusy = true;
  Promise.resolve()
    .then(task)
    .catch(() => {})
    .finally(() => {
      queueBusy = false;
      drainQueue();
    });
}

app.post("/api/generate", async (req, res, next) => {
  try {
    const plan = parseRequest(req.body || {});
    // Fail fast on an unknown model, a missing API key or a missing
    // PUBLIC_BASE_URL instead of surfacing it minutes later inside the job.
    await resolveSelection(plan.provider, plan.model);
    const name = plan.scene;

    const job = createJob({
      scene: name,
      provider: plan.provider,
      model: plan.model,
      abortController: new AbortController(),
    });
    logLine(job, "Queued.");

    queue.push(async () => {
      startJob(job);
      try {
        const result = await runGeneration(job, plan);
        finishJob(job, result);
        logLine(job, "Done - " + result.frames.length + " frames written to projects/" + result.dir);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        logLine(job, "Failed: " + message, "error");
        failJob(job, err);
      }
    });
    drainQueue();

    res.status(202).json({ jobId: job.id, scene: name });
  } catch (err) {
    next(err);
  }
});

app.get("/api/jobs/:id", (req, res, next) => {
  const job = getJob(req.params.id);
  if (!job) {
    next(new HttpError(404, "Unknown job"));
    return;
  }
  res.json({ job: publicJob(job), logs: job.logs });
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Unknown job" });
    return;
  }
  if (job.abortController) job.abortController.abort();
  logLine(job, "Cancellation requested.", "warn");
  setStage(job, "cancelling", job.progress);
  res.json({ ok: true });
});

app.get("/api/jobs/:id/events", (req, res, next) => {
  const job = getJob(req.params.id);
  if (!job) {
    next(new HttpError(404, "Unknown job"));
    return;
  }
  subscribe(job, req, res);
});

/* -------------------------------------------------------------- files */

function sendFileStrict(res, next, file) {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(file, (err) => {
    if (err) {
      if (res.headersSent) return;
      next(err.code === "ENOENT" ? new HttpError(404, "Not found") : err);
    }
  });
}

app.get("/api/files/uploads/:name", (req, res, next) => {
  try {
    const root = path.join(projectsDir(), ".uploads");
    sendFileStrict(res, next, safeJoin(root, req.params.name.replace(/^\.+/, "")));
  } catch (err) {
    next(err);
  }
});

app.get("/api/files/scenes/:scene/*", (req, res, next) => {
  try {
    const name = assertSceneName(req.params.scene);
    const rest = req.params[0];
    sendFileStrict(res, next, safeJoin(sceneDir(name), rest));
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- shell */

app.use(express.static(PUBLIC_DIR, { index: "index.html", dotfiles: "deny" }));

app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    sendFileStrict(res, next, path.join(PUBLIC_DIR, "index.html"));
    return;
  }
  next(new HttpError(404, "Not found"));
});

app.use((err, req, res, next) => {
  const payload = toErrorPayload(err);
  if (payload.status >= 500) {
    console.error("[error]", err);
  }
  if (res.headersSent) return;
  res.status(payload.status).json(payload.body);
});

/* ---------------------------------------------------------------- boot */

/**
 * .uploads holds the normalised copies of uploaded anchors (and is what Luma
 * fetches over PUBLIC_BASE_URL). Nothing else references them once a scene has
 * been written, so drop anything older than a week.
 */
async function pruneUploads(maxAgeDays = 7) {
  const dir = path.join(projectsDir(), ".uploads");
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(file, { force: true });
        removed += 1;
      }
    } catch {
      /* skip anything that vanished mid-scan */
    }
  }
  return removed;
}

async function boot() {
  await fs.mkdir(projectsDir(), { recursive: true });
  const pruned = await pruneUploads();
  if (pruned) console.log("Pruned " + pruned + " stale file(s) from projects/.uploads.");
  const created = await writeOverrideTemplate();
  if (created) console.log("Wrote providers.local.json (optional provider overrides).");

  try {
    const ffmpegPath = await resolveFfmpeg();
    await resolveFfprobe();
    console.log("ffmpeg: " + ffmpegPath);
  } catch (err) {
    console.warn("WARNING: " + (err && err.message ? err.message : String(err)));
  }

  const providers = await listProviders();
  console.log("Providers:");
  for (const provider of providers) {
    const state = provider.requiresKey ? (provider.keyPresent ? "key found" : "no key") : "no key needed";
    console.log("  - " + provider.label + " (" + provider.id + ", " + state + ", " + provider.models.length + " model(s))");
  }

  app.listen(config.port, config.host, () => {
    console.log("");
    console.log("framegenjutsu is running at http://" + config.host + ":" + config.port);
    console.log("Scenes are written to " + projectsDir());
    if (!config.publicBaseUrl) {
      console.log("PUBLIC_BASE_URL is not set: providers that need public image URLs (Luma) stay disabled.");
    }
    console.log("");
  });
}

boot().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
