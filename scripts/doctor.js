import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveFfmpeg, resolveFfprobe } from "../server/lib/media.js";
import { projectsDir } from "../server/lib/paths.js";
import { listProviders, OVERRIDE_FILE } from "../server/providers/index.js";
import { config } from "../server/config.js";

function line(ok, label, detail) {
  const mark = ok === null ? "  -" : ok ? " ok" : "  X";
  console.log("[" + mark + "] " + label + (detail ? "  " + detail : ""));
}

async function main() {
  console.log("");
  console.log("framegenjutsu doctor");
  console.log("================");

  line(true, "node", process.version);

  try {
    const ffmpeg = await resolveFfmpeg();
    line(true, "ffmpeg", ffmpeg);
  } catch (err) {
    line(false, "ffmpeg", err.message);
  }

  try {
    const ffprobe = await resolveFfprobe();
    line(true, "ffprobe", ffprobe);
  } catch (err) {
    line(false, "ffprobe", err.message);
  }

  const dir = projectsDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, ".write-test");
    await fs.writeFile(probe, "ok");
    await fs.rm(probe, { force: true });
    line(true, "projects dir", dir);
  } catch (err) {
    line(false, "projects dir", dir + " (" + err.message + ")");
  }

  line(true, "server", "http://" + config.host + ":" + config.port);
  line(config.publicBaseUrl ? true : null, "PUBLIC_BASE_URL", config.publicBaseUrl || "not set (Luma disabled)");
  line(true, "preview fps", String(config.previewFps));
  line(true, "max edge", config.maxEdge ? String(config.maxEdge) + "px" : "original size");

  try {
    await fs.access(OVERRIDE_FILE);
    line(true, "providers.local.json", "present");
  } catch {
    line(null, "providers.local.json", "not created yet (server writes it on first boot)");
  }

  console.log("");
  console.log("Providers");
  console.log("---------");
  const providers = await listProviders();
  for (const provider of providers) {
    const state = provider.requiresKey
      ? provider.keyPresent
        ? "key found"
        : "NO KEY - " + provider.keyEnv.join(" / ")
      : "no key needed";
    line(provider.requiresKey ? provider.keyPresent : true, provider.label, state + " (" + provider.models.length + " model(s))");
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
