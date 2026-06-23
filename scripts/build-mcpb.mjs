#!/usr/bin/env node
// Pack the .mcpb bundle for one-click install in Claude Desktop / Claude Code.
// Stages the built server + production node_modules + manifest, then runs
// `@anthropic-ai/mcpb pack`.
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const stage = path.join(repoRoot, "build-mcpb-stage");
const outDir = path.join(repoRoot, "dist");
const outFile = path.join(outDir, "drafts-mcp.mcpb");

const log = (m) => console.log(`[build-mcpb] ${m}`);

function rm(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function run(cmd, cwd) {
  log(`$ ${cmd} (cwd=${path.relative(repoRoot, cwd) || "."})`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(s);
      try {
        fs.symlinkSync(link, d);
      } catch {
        fs.copyFileSync(s, d);
      }
    } else fs.copyFileSync(s, d);
  }
}

log("cleaning previous stage");
rm(stage);
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

log("building TypeScript");
run("npm ci --ignore-scripts", repoRoot);
run("npx tsc", repoRoot);

log("staging server runtime");
copyDir(path.join(repoRoot, "build"), path.join(stage, "build"));
copyFile(path.join(repoRoot, "package.json"), path.join(stage, "package.json"));
copyFile(path.join(repoRoot, "package-lock.json"), path.join(stage, "package-lock.json"));

log("installing production node_modules into stage");
run("npm ci --omit=dev --ignore-scripts", stage);

log("copying manifest");
copyFile(path.join(repoRoot, "mcpb", "manifest.json"), path.join(stage, "manifest.json"));

const iconSrc = path.join(repoRoot, "mcpb", "icon.png");
if (fs.existsSync(iconSrc)) {
  copyFile(iconSrc, path.join(stage, "icon.png"));
}

log("packing .mcpb via @anthropic-ai/mcpb");
const result = spawnSync(
  "npx",
  ["--yes", "@anthropic-ai/mcpb@latest", "pack", stage, outFile],
  { stdio: "inherit", cwd: repoRoot, shell: process.platform === "win32" },
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

rm(stage);

const stat = fs.statSync(outFile);
log(`wrote ${path.relative(repoRoot, outFile)} (${(stat.size / 1024).toFixed(1)} KB)`);
