import { HttpError } from "../lib/errors.js";
import { fetchJson, pollUntil, firstMediaUrl } from "./http.js";
import { buildInput } from "./input.js";

const API = "https://api.replicate.com/v1";

function apiKey() {
  const key = process.env.REPLICATE_API_TOKEN;
  if (!key || !key.trim()) {
    throw new HttpError(400, "REPLICATE_API_TOKEN is not set. Add it to .env and restart the server.");
  }
  return key.trim();
}

export default {
  id: "replicate",
  label: "Replicate",
  homepage: "https://replicate.com",
  keyEnv: ["REPLICATE_API_TOKEN"],
  requiresKey: true,
  note: "Two predictions per scene (one per segment). Models that accept a start and an end image give the tightest in-betweens.",
  models: [
    {
      id: "kwaivgi/kling-v1.6-standard",
      label: "Kling 1.6 Standard (start + end frame)",
      strategy: "video",
      supportsEndFrame: true,
      note: "Cheap and fast. Good default for stylised scenes.",
      defaults: { duration: 5 },
      input: {
        prompt: "$prompt",
        negative_prompt: "$negative",
        start_image: "$first",
        end_image: "$last",
        duration: "$duration",
      },
    },
    {
      id: "kwaivgi/kling-v1.6-pro",
      label: "Kling 1.6 Pro (start + end frame)",
      strategy: "video",
      supportsEndFrame: true,
      note: "Higher fidelity, slower and more expensive than Standard.",
      defaults: { duration: 5 },
      input: {
        prompt: "$prompt",
        negative_prompt: "$negative",
        start_image: "$first",
        end_image: "$last",
        duration: "$duration",
      },
    },
    {
      id: "kwaivgi/kling-v2.1",
      label: "Kling 2.1 (start + end frame)",
      strategy: "video",
      supportsEndFrame: true,
      note: "Newer Kling. Duration and input names differ between releases.",
      defaults: { duration: 5 },
      input: {
        prompt: "$prompt",
        negative_prompt: "$negative",
        start_image: "$first",
        end_image: "$last",
        duration: "$duration",
      },
    },
    {
      id: "wan-video/wan-2.2-i2v-fast",
      label: "Wan 2.2 I2V Fast (start + end frame)",
      strategy: "video",
      supportsEndFrame: true,
      note: "Open-weight model, very cheap. Input names change between versions - edit providers.local.json if it 422s.",
      defaults: { duration: 5 },
      input: {
        prompt: "$prompt",
        image: "$first",
        last_image: "$last",
      },
    },
  ],

  async render(ctx) {
    const key = apiKey();
    const parts = String(ctx.model.id).split("/");
    if (parts.length !== 2) {
      throw new HttpError(500, "Replicate model ids look like 'owner/name'");
    }
    const [owner, name] = parts;
    const input = buildInput(ctx.model, ctx);

    ctx.log("Replicate: submitting " + ctx.model.id);
    const created = await fetchJson(API + "/models/" + owner + "/" + name + "/predictions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify({ input }),
      timeoutMs: 120000,
      signal: ctx.signal,
      label: "Replicate prediction",
    });

    if (!created || !created.id) {
      throw new HttpError(502, "Replicate did not return a prediction id: " + JSON.stringify(created).slice(0, 400));
    }
    ctx.log("Replicate: prediction " + created.id + " (" + (created.status || "starting") + ")");

    const output = await pollUntil(
      async () => {
        if (created.status === "succeeded") return { done: true, value: created.output };
        if (created.status === "failed" || created.status === "canceled") {
          return { failed: true, error: created.error || created.status };
        }
        const current = await fetchJson(API + "/predictions/" + created.id, {
          headers: { Authorization: "Bearer " + key },
          timeoutMs: 60000,
          signal: ctx.signal,
          label: "Replicate poll",
          retries: 3,
        });
        created.status = current.status;
        if (current.status === "succeeded") return { done: true, value: current.output };
        if (current.status === "failed" || current.status === "canceled") {
          return { failed: true, error: current.error || current.status };
        }
        if (current.logs) ctx.progressTick(current.logs.slice(-200));
        return {};
      },
      { intervalMs: 3000, signal: ctx.signal, label: "Replicate generation" }
    );

    const url = firstMediaUrl(output, [".mp4", ".webm", ".mov"]);
    if (!url) {
      throw new HttpError(502, "Replicate returned no video in its output: " + JSON.stringify(output).slice(0, 400));
    }
    ctx.log("Replicate: prediction finished");
    return { videoUrl: url };
  },
};
