import { HttpError } from "../lib/errors.js";
import { fetchJson, pollUntil } from "./http.js";

const API = "https://api.lumalabs.ai/dream-machine/v1";

function apiKey() {
  const key = process.env.LUMAAI_API_KEY || process.env.LUMA_API_KEY;
  if (!key || !key.trim()) {
    throw new HttpError(400, "LUMAAI_API_KEY is not set. Add it to .env and restart the server.");
  }
  return key.trim();
}

export default {
  id: "luma",
  label: "Luma Dream Machine",
  homepage: "https://lumalabs.ai",
  keyEnv: ["LUMAAI_API_KEY", "LUMA_API_KEY"],
  requiresKey: true,
  note: "Luma only accepts publicly reachable image URLs. Set PUBLIC_BASE_URL in .env (for example an ngrok or Cloudflare tunnel pointing at this server) before using it.",
  models: [
    {
      id: "ray-2",
      label: "Ray 2 (keyframe start + end)",
      strategy: "video",
      supportsEndFrame: true,
      requiresPublicUrl: true,
      defaults: { duration: 5 },
    },
    {
      id: "ray-flash-2",
      label: "Ray Flash 2 (keyframe start + end)",
      strategy: "video",
      supportsEndFrame: true,
      requiresPublicUrl: true,
      defaults: { duration: 5 },
    },
  ],

  async render(ctx) {
    const key = apiKey();
    if (!ctx.first.publicUrl || !ctx.last.publicUrl) {
      throw new HttpError(400, "Luma needs publicly reachable image URLs. Set PUBLIC_BASE_URL in .env to a tunnel that points at this server, then retry.");
    }

    const body = {
      prompt: ctx.prompt || "Smooth, natural motion between the two keyframes.",
      model: ctx.model.id,
      resolution: ctx.resolution || "720p",
      duration: String(ctx.duration) + "s",
      keyframes: {
        frame0: { type: "image", url: ctx.first.publicUrl },
        frame1: { type: "image", url: ctx.last.publicUrl },
      },
    };

    ctx.log("Luma: submitting " + ctx.model.id + " generation");
    const created = await fetchJson(API + "/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      timeoutMs: 120000,
      signal: ctx.signal,
      label: "Luma submit",
    });

    if (!created || !created.id) {
      throw new HttpError(502, "Luma did not return a generation id: " + JSON.stringify(created).slice(0, 400));
    }
    ctx.log("Luma: generation " + created.id);

    return pollUntil(
      async () => {
        const generation = await fetchJson(API + "/generations/" + created.id, {
          headers: { Authorization: "Bearer " + key, Accept: "application/json" },
          timeoutMs: 60000,
          signal: ctx.signal,
          label: "Luma poll",
          retries: 3,
        });
        const state = String(generation.state || "").toLowerCase();
        if (state === "completed") {
          const url = generation.assets && (generation.assets.video || generation.assets.video_url);
          if (!url) {
            throw new HttpError(502, "Luma returned no video: " + JSON.stringify(generation).slice(0, 400));
          }
          ctx.log("Luma: generation finished");
          return { done: true, value: { videoUrl: url } };
        }
        if (state === "failed") {
          return { failed: true, error: generation.failure_reason || "failed" };
        }
        return {};
      },
      { intervalMs: 4000, signal: ctx.signal, label: "Luma generation" }
    );
  },
};
