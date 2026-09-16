import { HttpError } from "../lib/errors.js";
import { fetchJson, pollUntil, firstMediaUrl } from "./http.js";
import { buildInput } from "./input.js";

const QUEUE = "https://queue.fal.run";

function apiKey() {
  const key = process.env.FAL_KEY;
  if (!key || !key.trim()) {
    throw new HttpError(400, "FAL_KEY is not set. Add it to .env and restart the server.");
  }
  return key.trim();
}

export default {
  id: "fal",
  label: "fal.ai",
  homepage: "https://fal.ai",
  keyEnv: ["FAL_KEY"],
  requiresKey: true,
  note: "Queue based: one job per segment, then the clip is downsampled into the requested in-between frames.",
  models: [
    {
      id: "fal-ai/kling-video/v1.6/standard/image-to-video",
      label: "Kling 1.6 Standard (start + end frame)",
      strategy: "video",
      supportsEndFrame: true,
      note: "Reliable first/last-frame conditioning.",
      defaults: { duration: 5 },
      input: {
        prompt: "$prompt",
        negative_prompt: "$negative",
        start_image_url: "$first",
        tail_image_url: "$last",
        duration: "$durationStr",
      },
    },
    {
      id: "fal-ai/minimax/hailuo-02/standard/image-to-video",
      label: "MiniMax Hailuo 02 Standard (start + end frame)",
      strategy: "video",
      supportsEndFrame: true,
      defaults: { duration: 6 },
      input: {
        prompt: "$prompt",
        image_url: "$first",
        end_image_url: "$last",
        duration: "$durationStr",
      },
    },
    {
      id: "fal-ai/luma-dream-machine/ray-2/image-to-video",
      label: "Luma Ray 2 (start + end frame)",
      strategy: "video",
      supportsEndFrame: true,
      defaults: { duration: 5 },
      input: {
        prompt: "$prompt",
        image_url: "$first",
        end_image_url: "$last",
        duration: "$durationStr",
      },
    },
    {
      id: "fal-ai/wan-i2v",
      label: "Wan I2V (start frame only)",
      strategy: "video",
      supportsEndFrame: false,
      note: "No end-frame conditioning, so the last in-between will not land exactly on your middle anchor.",
      defaults: { duration: 5 },
      input: {
        prompt: "$prompt",
        image_url: "$first",
      },
    },
  ],

  async render(ctx) {
    const key = apiKey();
    const input = buildInput(ctx.model, ctx);

    ctx.log("fal.ai: queueing " + ctx.model.id);
    const submitted = await fetchJson(QUEUE + "/" + ctx.model.id, {
      method: "POST",
      headers: {
        Authorization: "Key " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      timeoutMs: 120000,
      signal: ctx.signal,
      label: "fal.ai submit",
    });

    const statusUrl = submitted && (submitted.status_url || (submitted.request_id ? QUEUE + "/" + ctx.model.id + "/requests/" + submitted.request_id + "/status" : null));
    const responseUrl = submitted && (submitted.response_url || (submitted.request_id ? QUEUE + "/" + ctx.model.id + "/requests/" + submitted.request_id : null));
    if (!statusUrl || !responseUrl) {
      throw new HttpError(502, "fal.ai did not return queue URLs: " + JSON.stringify(submitted).slice(0, 400));
    }
    ctx.log("fal.ai: request " + (submitted.request_id || "queued"));

    return pollUntil(
      async () => {
        const status = await fetchJson(statusUrl, {
          headers: { Authorization: "Key " + key },
          timeoutMs: 60000,
          signal: ctx.signal,
          label: "fal.ai status",
          retries: 3,
        });
        const state = String(status.status || status.state || "").toUpperCase();
        if (state === "COMPLETED") {
          const result = await fetchJson(responseUrl, {
            headers: { Authorization: "Key " + key },
            timeoutMs: 120000,
            signal: ctx.signal,
            label: "fal.ai result",
            retries: 3,
          });
          const url = firstMediaUrl(result, [".mp4", ".webm", ".mov"]);
          if (!url) {
            throw new HttpError(502, "fal.ai returned no video: " + JSON.stringify(result).slice(0, 400));
          }
          ctx.log("fal.ai: completed");
          return { done: true, value: { videoUrl: url } };
        }
        if (state === "FAILED" || state === "ERROR") {
          return { failed: true, error: JSON.stringify(status).slice(0, 300) };
        }
        return {};
      },
      { intervalMs: 3000, signal: ctx.signal, label: "fal.ai generation" }
    );
  },
};
