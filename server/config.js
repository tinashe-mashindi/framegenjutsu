import "dotenv/config";

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST && process.env.HOST.trim() ? process.env.HOST.trim() : "127.0.0.1",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, ""),
  maxEdge: Math.max(0, num(process.env.MAX_EDGE, 0)),
  previewFps: Math.max(1, Math.min(60, num(process.env.PREVIEW_FPS, 12))),
  jsonLimit: "64mb",
};

export function hasPublicBaseUrl() {
  return Boolean(config.publicBaseUrl);
}
