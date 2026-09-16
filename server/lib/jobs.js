import crypto from "node:crypto";

const jobs = new Map();
const MAX_JOBS = 60;
const MAX_LOG_LINES = 600;

function nowIso() {
  return new Date().toISOString();
}

export function createJob(meta = {}) {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: "queued",
    stage: "queued",
    progress: 0,
    logs: [],
    result: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    subscribers: new Set(),
    ...meta,
  };
  jobs.set(id, job);
  prune();
  return job;
}

function prune() {
  if (jobs.size <= MAX_JOBS) return;
  const ordered = [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const job of ordered) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.status === "queued" || job.status === "running") continue;
    jobs.delete(job.id);
  }
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    scene: job.scene || null,
    provider: job.provider || null,
    model: job.model || null,
    logCount: job.logs.length,
    result: job.result,
    error: job.error,
  };
}

function publish(job, event, data) {
  const payload = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  for (const res of [...job.subscribers]) {
    try {
      res.write(payload);
    } catch {
      job.subscribers.delete(res);
    }
  }
}

export function logLine(job, message, level = "info") {
  const entry = { at: nowIso(), level, message: String(message) };
  job.logs.push(entry);
  if (job.logs.length > MAX_LOG_LINES) job.logs.shift();
  job.updatedAt = entry.at;
  publish(job, "log", entry);
  return entry;
}

export function setStage(job, stage, progress) {
  job.stage = stage;
  if (typeof progress === "number" && Number.isFinite(progress)) {
    job.progress = Math.max(0, Math.min(100, Math.round(progress)));
  }
  job.updatedAt = nowIso();
  publish(job, "state", publicJob(job));
}

export function startJob(job) {
  job.status = "running";
  job.updatedAt = nowIso();
  publish(job, "state", publicJob(job));
}

export function finishJob(job, result) {
  job.status = "done";
  job.stage = "done";
  job.progress = 100;
  job.result = result;
  job.updatedAt = nowIso();
  publish(job, "state", publicJob(job));
  publish(job, "done", result);
}

export function failJob(job, err) {
  job.status = "error";
  job.stage = "error";
  job.error = err && err.message ? err.message : String(err);
  job.updatedAt = nowIso();
  publish(job, "state", publicJob(job));
  publish(job, "failed", { message: job.error });
}

export function subscribe(job, req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
  for (const entry of job.logs) {
    res.write("event: log\ndata: " + JSON.stringify(entry) + "\n\n");
  }
  res.write("event: state\ndata: " + JSON.stringify(publicJob(job)) + "\n\n");
  if (job.status === "done") res.write("event: done\ndata: " + JSON.stringify(job.result) + "\n\n");
  if (job.status === "error") res.write("event: failed\ndata: " + JSON.stringify({ message: job.error }) + "\n\n");

  job.subscribers.add(res);
  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(keepAlive);
    job.subscribers.delete(res);
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
}
