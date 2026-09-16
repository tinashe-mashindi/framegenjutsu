import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../lib/paths.js";

export default {
  id: "demo",
  label: "Demo (no API)",
  homepage: "https://github.com",
  keyEnv: [],
  requiresKey: false,
  offline: true,
  note: "Never leaves your machine and never invents motion. It exists so you can rehearse the whole pipeline - numbering, folders, manifest, preview - without spending a credit.",
  models: [
    {
      id: "pipeline-test",
      label: "Pipeline test (copies the anchors)",
      strategy: "sequence",
      supportsEndFrame: true,
      note: "In-between frames are copies of your anchors. Use it to verify folders and naming only.",
    },
  ],

  async render(ctx) {
    const outDir = path.join(ctx.workDir, "demo");
    await fs.rm(outDir, { recursive: true, force: true });
    await ensureDir(outDir);

    const framePaths = [];
    for (let i = 1; i <= ctx.count; i++) {
      const useFirst = i * 2 <= ctx.count;
      const source = useFirst ? ctx.first.path : ctx.last.path;
      const dest = path.join(outDir, "demo-" + String(i).padStart(3, "0") + ".png");
      await fs.copyFile(source, dest);
      framePaths.push(dest);
    }
    ctx.log("Demo provider: wrote " + framePaths.length + " placeholder in-between frame(s).");
    return { framePaths };
  },
};
