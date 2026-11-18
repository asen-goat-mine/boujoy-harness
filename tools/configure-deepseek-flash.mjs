import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// Use the runtime's supported settings overlay; never rewrite dependency code.
const root = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node configure-deepseek-flash.mjs <runtime-root>");
const meta = path.join(root, "boujoy-runtime.json");
const upstream = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, "utf8")).upstreamRoot : root;
const require = createRequire(fs.realpathSync(path.join(upstream, "node_modules/@deepseek-ai/dsh/package.json")));
const yaml = require("js-yaml");
const canonical = { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", inputModalities: ["text", "image"] };
for (const mode of ["home", "clean-home"]) {
  const filename = path.join(root, mode, "settings.yaml");
  const data = yaml.load(fs.readFileSync(filename, "utf8")) || {};
  const provider = data["llm-deepseek"] || {};
  const existing = provider.models || [
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash", name: "Flash（旧会话兼容 ID）" },
    { id: "deepseek-v4-flash-vision-exp", name: "Flash Vision（旧会话兼容 ID）", inputModalities: ["text", "image"] },
  ];
  data["llm-deepseek"] = { ...provider, models: [canonical, ...existing.filter(model => model.id !== canonical.id)] };
  const selected = data["agent-default-model"] || {};
  if (!selected.provider || (selected.provider === "deepseek-official" && ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-flash"].includes(selected.model))) {
    data["agent-default-model"] = { ...selected, provider: "deepseek-official", model: canonical.id };
  }
  const incoming = filename + ".incoming";
  fs.writeFileSync(incoming, yaml.dump(data, { lineWidth: -1 }), { mode: 0o600 });
  fs.renameSync(incoming, filename);
  console.log(`${mode}: canonical Flash model configured; other providers and credentials preserved`);
}
