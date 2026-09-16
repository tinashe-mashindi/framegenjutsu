import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { HttpError } from "./errors.js";

export const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const PUBLIC_DIR = path.join(ROOT, "public");
export const DEFAULT_PROJECTS_DIR = path.join(ROOT, "projects");
export const WORK_DIR_NAME = ".work";

const SCENE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function projectsDir() {
  const override = process.env.PROJECTS_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return DEFAULT_PROJECTS_DIR;
}

export function assertSceneName(raw) {
  if (typeof raw !== "string") throw new HttpError(400, "scene_name is required");
  const name = raw.trim();
  if (!name) throw new HttpError(400, "scene_name is required");
  if (name.includes("..")) throw new HttpError(400, "scene_name may not contain '..'");
  if (!SCENE_RE.test(name)) {
    throw new HttpError(400, "scene_name may only use letters, digits, dot, dash and underscore (max 64 characters, must start with a letter or digit)");
  }
  return name;
}

export function sceneDir(raw) {
  const name = assertSceneName(raw);
  const root = projectsDir();
  const dir = path.join(root, name);
  // Defence in depth: the resolved path must stay inside the projects root.
  if (path.relative(root, dir).startsWith("..")) {
    throw new HttpError(400, "scene_name escapes the projects directory");
  }
  return dir;
}

export function workDir(raw) {
  return path.join(sceneDir(raw), WORK_DIR_NAME);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function listScenes() {
  const root = projectsDir();
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const manifestPath = path.join(root, entry.name, "manifest.json");
    let manifest = null;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch {
      manifest = null;
    }
    out.push({
      scene: entry.name,
      hasManifest: Boolean(manifest),
      frameCount: manifest && Array.isArray(manifest.frames) ? manifest.frames.length : null,
      createdAt: manifest ? manifest.createdAt : null,
      provider: manifest ? manifest.provider : null,
      model: manifest ? manifest.model : null,
    });
  }
  out.sort((a, b) => String(b.createdAt || b.scene).localeCompare(String(a.createdAt || a.scene)));
  return out;
}
