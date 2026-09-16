import { HttpError } from "../lib/errors.js";
import { fetchJson, pollUntil, firstMediaUrl } from "./http.js";
import { buildInput } from "./input.js";

const API = "https://api.dev.runwayml.com/v1";
const RUNWAY_VERSION = "2024-11-06";

function apiKey() {
  const key = process.env.RUNWAYML_API_SECRET || process.env.RUNWAY_API_KEY;
  if (!key || !key.trim()) {
    throw new HttpError(400, "RUNWAYML_API_SECRET is not set. Add it to .env and restart the server.");
  }
  return key.trim();
}

const COMMON_INPUT = {
  promptText: "$prompt",
  promptImage: "$firstLastArray",
  ratio: "$aspectRatio",
  duration: "$duration",
};

export default {
  id: "runway",
  label: "Runway",
  homepage: "https://dev.runwayml.com",
  keyEnv: ["RUNWAYML_API_SECRET", "RUNWAY_API_KEY"],
  requiresKey: true,
  note: "promptImage is sent as [start, end] so Runway conditions on both anchors. If your account/model only accepts a single image, change promptImage to $first in providers.local.json.",
  models: [
    {
      id: "gen4_turbo",
      label: "Gen-4 Turbo (start + end frame)",
      strategy: "video",
      supportsEndFrame: true,
      defaults: { duration: 5 },
      input: { model: "gen4_turbo", ...COMMON_INPUT },
    },
    {
      id: "gen3a_turbo",
      label: "Gen-3 Alpha Turbo (start + end frame)",
      strategy: "video",
      supportsEndFrame: true,
      defaults: { duration: 5 },
      input: { model: "gen3a_turbo", ...COMMON_INPUT },
    },
  ],

  async render(ctx) {
    const key = apiKey();
    const input = buildInput(ctx.model, ctx);

    ctx.log("Runway: submitting " + input.model);
    const created = await fetchJson(API + "/image_to_video", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        "X-Runway-Version": RUNWAY_VERSION,
      },
      body: JSON.stringify(input),
      timeoutMs: 120000,
      signal: ctx.signal,
      label: "Runway submit",
    });

    if (!created || !created.id) {
      throw new HttpError(502, "Runway did not return a task id: " + JSON.stringify(created).slice(0, 400));
    }
    ctx.log("Runway: task " + created.id);

    return pollUntil(
      async () => {
        const task = await fetchJson(API + "/tasks/" + created.id, {
          headers: {
            Authorization: "Bearer " + key,
            "X-Runway-Version": RUNWAY_VERSION,
          },
          timeoutMs: 60000,
          signal: ctx.signal,
          label: "Runway poll",
          retries: 3,
        });
        const status = String(task.status || "").toUpperCase();
        if (status === "SUCCEEDED") {
          const url = firstMediaUrl(task.output, [".mp4", ".webm", ".mov"]);
          if (!url) {
            throw new HttpError(502, "Runway returned no video: " + JSON.stringify(task).slice(0, 400));
          }
          ctx.log("Runway: task finished");
          return { done: true, value: { videoUrl: url } };
        }
        if (status === "FAILED" || status === "CANCELLED") {
          return { failed: true, error: task.failure || task.failureCode || status };
        }
        return {};
      },
      { intervalMs: 4000, signal: ctx.signal, label: "Runway generation" }
    );
  },
};
