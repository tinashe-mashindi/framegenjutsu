import { HttpError } from "../lib/errors.js";

export const DEFAULT_POLL_TIMEOUT_MS = 20 * 60 * 1000;

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new HttpError(499, "Request cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new HttpError(499, "Request cancelled"));
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function timeoutSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  return signal;
}

export async function fetchJson(url, options = {}) {
  const {
    timeoutMs = 180000,
    retries = 2,
    label = "Request",
    signal,
    ...init
  } = options;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const res = await fetch(url, { ...init, signal: timeoutSignal(timeoutMs, signal) });
      const text = await res.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (res.ok) return json === null ? { raw: text } : json;

      const detail = (json ? JSON.stringify(json) : text).slice(0, 700);
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (retryable && attempt <= retries) {
        await sleep(Math.min(20000, 1500 * Math.pow(2, attempt - 1)), signal);
        continue;
      }
      throw new HttpError(502, label + " failed (HTTP " + res.status + "): " + detail);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = err && err.message ? err.message : String(err);
      if (attempt <= retries) {
        await sleep(Math.min(20000, 1500 * Math.pow(2, attempt - 1)), signal);
        continue;
      }
      throw new HttpError(502, label + " request error: " + message);
    }
  }
}

/**
 * step() must return { done: true, value } when finished,
 * { failed: true, error } on provider-side failure, or nothing while pending.
 */
export async function pollUntil(step, opts = {}) {
  const { intervalMs = 3000, timeoutMs = DEFAULT_POLL_TIMEOUT_MS, label = "Generation", onTick, signal } = opts;
  const started = Date.now();
  for (;;) {
    const result = await step();
    if (result && result.done) return result.value;
    if (result && result.failed) {
      throw new HttpError(502, label + " failed: " + (result.error || "the provider reported a failure"));
    }
    const elapsed = Date.now() - started;
    if (elapsed > timeoutMs) {
      throw new HttpError(504, label + " timed out after " + Math.round(elapsed / 1000) + "s");
    }
    if (onTick) onTick(elapsed, result);
    await sleep(intervalMs, signal);
  }
}

export function firstMediaUrl(output, extensions) {
  const list = [];
  const push = (value) => {
    if (typeof value === "string" && /^https?:/.test(value)) list.push(value);
  };
  const walk = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === "string") {
      push(value);
      return;
    }
    if (typeof value === "object") {
      for (const key of ["url", "video", "video_url", "output", "file", "uri"]) {
        if (value[key]) walk(value[key]);
      }
    }
  };
  walk(output);
  if (!list.length) return null;
  if (!extensions || !extensions.length) return list[0];
  const match = list.find((url) => extensions.some((ext) => url.toLowerCase().includes(ext)));
  return match || list[0];
}
