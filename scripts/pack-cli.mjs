#!/usr/bin/env node
/**
 * Packs the built CLI (dist/) as an npm-installable tarball, web-dist/cli.tgz
 * by default, which the Worker serves publicly so a cloud environment's
 * setup script can run `npm install -g https://<host>/cli.tgz`. It holds no
 * secrets. Run after `build:cli` and `build:web` (Vite empties web-dist).
 *
 * It stamps the package with a build id, a hash of its contents, in
 * build.json, and writes the same to cli-version.json beside the tarball,
 * which the site serves so `kim` can tell when it's out of date.
 *
 *   node scripts/pack-cli.mjs [--out <file>]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFlag = process.argv.indexOf("--out");
const out = resolve(
  outFlag >= 0 ? process.argv[outFlag + 1] : join(repo, "web-dist", "cli.tgz"),
);
const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const dist = join(repo, "dist");
if (!existsSync(join(dist, "cli.js")))
  throw new Error("dist/cli.js is missing: run `npm run build:cli` first");

// The files cli.js reaches through relative imports, and the packages they
// import. Each package must be a declared dependency, so a server- or
// web-only import fails the build instead of a cloud session's install.
const builtins = new Set(builtinModules);
const imported = new Set();
const files = [];
const pending = ["cli.js"];
while (pending.length) {
  const file = pending.pop();
  if (files.includes(file)) continue;
  files.push(file);
  const code = readFileSync(join(dist, file), "utf8");
  for (const match of code.matchAll(
    /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    if (specifier.startsWith(".")) {
      pending.push(relative(dist, resolve(dist, dirname(file), specifier)));
      continue;
    }
    if (specifier.startsWith("node:") || builtins.has(specifier)) continue;
    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    imported.add(name);
  }
}
const dependencies = {};
for (const name of [...imported].sort()) {
  const version = root.dependencies?.[name];
  if (!version)
    throw new Error(
      `The CLI imports ${name}, which isn't a dependency in package.json`,
    );
  dependencies[name] = version;
}

const stage = mkdtempSync(join(tmpdir(), "kim-pack-"));
try {
  for (const file of files)
    cpSync(join(dist, file), join(stage, "dist", file), { recursive: true });
  cpSync(join(repo, "skills"), join(stage, "skills"), { recursive: true });
  for (const file of ["README.md", "LICENSE"])
    cpSync(join(repo, file), join(stage, file));
  const manifest = {
    name: root.name,
    version: root.version,
    description: "kim, the Keep it moving CLI.",
    type: "module",
    license: root.license,
    engines: root.engines,
    bin: root.bin,
    files: ["dist", "skills", "build.json", "README.md", "LICENSE"],
    dependencies,
  };
  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const stamp = `${JSON.stringify({ version: root.version, build: contentHash(stage) })}\n`;
  writeFileSync(join(stage, "build.json"), stamp);
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", stage], {
      cwd: stage,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(join(stage, packed.filename), out);
  writeFileSync(join(dirname(out), "cli-version.json"), stamp);
  process.stdout.write(
    `${out}: ${packed.entryCount} files, ${packed.size} bytes; dependencies ${JSON.stringify(dependencies)}; ${stamp}`,
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}

/** A short hash of every file under `dir`, by path and content. */
function contentHash(dir) {
  const hash = createHash("sha256");
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        hash
          .update(relative(dir, path))
          .update("\0")
          .update(readFileSync(path))
          .update("\0");
    }
  };
  walk(dir);
  return hash.digest("hex").slice(0, 12);
}
