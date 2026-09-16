import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "../lib/paths.js";
import { HttpError } from "../lib/errors.js";
import replicate from "./replicate.js";
import fal from "./fal.js";
import runway from "./runway.js";
import luma from "./luma.js";
import local from "./local.js";
import demo from "./demo.js";

const ADAPTERS = { replicate, fal, runway, luma, local, demo };
const BUILTIN = [replicate, fal, runway, luma, local, demo];
export const OVERRIDE_FILE = path.join(ROOT, "providers.local.json");

let registry = null;

function publicShape(provider) {
  return {
    id: provider.id,
    label: provider.label,
    homepage: provider.homepage || null,
    keyEnv: provider.keyEnv || [],
    requiresKey: Boolean(provider.requiresKey),
    offline: Boolean(provider.offline),
    note: provider.note || null,
    models: (provider.models || []).map((model) => ({ ...model })),
  };
}

function hasKey(provider) {
  if (!provider.requiresKey) return true;
  return (provider.keyEnv || []).some((name) => Boolean(process.env[name] && String(process.env[name]).trim()));
}

function mergeModels(baseModels, overrideModels) {
  const out = baseModels.map((model) => ({ ...model }));
  for (const override of overrideModels) {
    if (!override || !override.id) continue;
    const index = out.findIndex((model) => model.id === override.id);
    if (index >= 0) {
      const current = out[index];
      out[index] = {
        ...current,
        ...override,
        input: override.input ? { ...(current.input || {}), ...override.input } : current.input,
      };
    } else {
      out.push({ ...override });
    }
  }
  return out;
}

async function readOverride() {
  try {
    const text = await fs.readFile(OVERRIDE_FILE, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.providers)) return parsed.providers;
    return [];
  } catch {
    return [];
  }
}

export async function loadProviders() {
  if (registry) return registry;
  const list = BUILTIN.map((provider) => ({ ...publicShape(provider), render: provider.render }));

  for (const entry of await readOverride()) {
    if (!entry || !entry.id) continue;
    const adapterId = entry.adapter || entry.id;
    const adapter = ADAPTERS[adapterId];
    const existing = list.find((provider) => provider.id === entry.id);
    const fallback = existing || (adapter ? publicShape(adapter) : null);
    if (!fallback) continue;

    const merged = {
      ...fallback,
      ...entry,
      render: adapter ? adapter.render : existing ? existing.render : null,
      models: mergeModels(fallback.models || [], entry.models || []),
    };
    delete merged.adapter;
    if (existing) Object.assign(existing, merged);
    else list.push(merged);
  }

  registry = list;
  return registry;
}

export async function listProviders() {
  const list = await loadProviders();
  return list.map((provider) => ({
    id: provider.id,
    label: provider.label,
    homepage: provider.homepage,
    keyEnv: provider.keyEnv || [],
    requiresKey: Boolean(provider.requiresKey),
    offline: Boolean(provider.offline),
    keyPresent: hasKey(provider),
    note: provider.note,
    models: provider.models,
  }));
}

export async function getProvider(id) {
  const list = await loadProviders();
  return list.find((provider) => provider.id === id) || null;
}

export async function resolveSelection(providerId, modelId) {
  const provider = await getProvider(providerId);
  if (!provider) throw new HttpError(400, "Unknown provider '" + providerId + "'");
  if (provider.requiresKey && !hasKey(provider)) {
    throw new HttpError(400, provider.label + " needs " + (provider.keyEnv || []).join(" or ") + " in your .env file.");
  }
  const models = provider.models || [];
  if (!models.length) throw new HttpError(400, provider.label + " has no models configured");
  const model = modelId ? models.find((entry) => entry.id === modelId) : models[0];
  if (!model) throw new HttpError(400, "Unknown model '" + modelId + "' for " + provider.label);
  return { provider, model };
}

export async function writeOverrideTemplate() {
  try {
    await fs.access(OVERRIDE_FILE);
    return false;
  } catch {
    /* missing: create it */
  }
  const template = {
    _readme:
      "Optional overrides for the provider registry. Anything listed here wins over the built-in defaults. " +
      "GET /api/providers returns the live registry including each model's input map - copy a model block from there, " +
      "paste it under providers[].models[] and edit it. Restart the server after editing.",
    _schema: {
      providers: [
        {
          id: "built-in provider id, or a brand new id",
          adapter: "optional: replicate | fal | runway | luma | local | demo - reuses that provider's transport",
          label: "shown in the UI",
          keyEnv: ["ENV_VAR_NAME"],
          requiresKey: true,
          note: "free text shown under the dropdown",
          models: [
            {
              id: "owner/name-as-the-provider-expects",
              label: "shown in the UI",
              strategy: "video | sequence",
              supportsEndFrame: true,
              requiresPublicUrl: false,
              defaults: { duration: 5 },
              input: { prompt: "$prompt", start_image: "$first", end_image: "$last" },
            },
          ],
        },
      ],
    },
    providers: [],
  };
  await fs.writeFile(OVERRIDE_FILE, JSON.stringify(template, null, 2) + "\n", "utf8");
  return true;
}
