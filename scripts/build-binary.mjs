#!/usr/bin/env node
// Build single-file standalone binaries via Bun --compile, for users without
// Node installed. macOS only (the server shells out to `open` and reads the
// macOS Drafts group container).
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outDir = path.join(repoRoot, "dist", "bin");

const log = (m) => console.log(`[build-binary] ${m}`);

const TARGETS = parseTargets();

function parseTargets() {
  const arg = process.argv.slice(2).find((a) => a.startsWith("--targets="));
  if (arg) {
    return arg.slice("--targets=".length).split(",").map((t) => t.trim()).filter(Boolean);
  }
  if (process.env.BUILD_TARGETS) {
    return process.env.BUILD_TARGETS.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return ["bun-darwin-arm64", "bun-darwin-x64"];
}

function run(cmd, cwd = repoRoot) {
  log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

function which(bin) {
  try {
    return execSync(process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .split(/\r?\n/)[0]
      .trim();
  } catch {
    return "";
  }
}

const bunPath = which("bun");
if (!bunPath) {
  console.error(
    "[build-binary] bun not found on PATH. Install via mise (`mise install`) or https://bun.sh.",
  );
  process.exit(1);
}
log(`using bun at ${bunPath}`);

run("npm ci --ignore-scripts", repoRoot);
run("npx tsc", repoRoot);

fs.mkdirSync(outDir, { recursive: true });

const entry = path.join(repoRoot, "build", "index.js");
if (!fs.existsSync(entry)) {
  console.error(`[build-binary] missing ${entry}; tsc did not emit build/index.js`);
  process.exit(1);
}

for (const target of TARGETS) {
  const name = `drafts-mcp-${target.replace(/^bun-/, "")}`;
  const outPath = path.join(outDir, name);
  log(`compiling ${target} → ${path.relative(repoRoot, outPath)}`);
  const result = spawnSync(
    bunPath,
    ["build", "--compile", `--target=${target}`, entry, "--outfile", outPath],
    { stdio: "inherit", cwd: repoRoot },
  );
  if (result.status !== 0) {
    console.error(`[build-binary] bun build failed for target ${target}`);
    process.exit(result.status ?? 1);
  }
}

log(`done. binaries in ${path.relative(repoRoot, outDir)}/`);
