import { HttpError } from "../lib/errors.js";

const TOKENS = {
  $prompt: (ctx) => ctx.prompt,
  $negative: (ctx) => ctx.negativePrompt,
  $first: (ctx) => ctx.first.dataUrl,
  $last: (ctx) => ctx.last.dataUrl,
  $firstPath: (ctx) => ctx.first.path,
  $lastPath: (ctx) => ctx.last.path,
  $firstPublic: (ctx) => ctx.first.publicUrl,
  $lastPublic: (ctx) => ctx.last.publicUrl,
  $firstLastArray: (ctx) => [ctx.first.dataUrl, ctx.last.dataUrl],
  $duration: (ctx) => ctx.duration,
  $durationStr: (ctx) => String(ctx.duration),
  $count: (ctx) => ctx.count,
  $fps: (ctx) => ctx.fps,
  $aspectRatio: (ctx) => ctx.aspectRatio,
  $aspectRatioSimple: (ctx) => ctx.aspectRatioSimple,
  $resolution: (ctx) => ctx.resolution,
};

function resolveValue(spec, ctx, key) {
  if (typeof spec === "string" && spec.charAt(0) === "$") {
    const token = TOKENS[spec];
    if (!token) throw new HttpError(500, "Unknown provider input token '" + spec + "' for key '" + key + "'");
    return token(ctx);
  }
  return spec;
}

export function buildInput(model, ctx) {
  const map = model.input || {};
  const out = {};
  for (const key of Object.keys(map)) {
    const value = resolveValue(map[key], ctx, key);
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export function tokenNames() {
  return Object.keys(TOKENS);
}
