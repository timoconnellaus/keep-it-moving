#!/usr/bin/env node
import {
  mkdirSync,
  lstatSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(repo, "skills/interviewer");
const canonical = resolve(homedir(), ".agents/skills/interviewer");
const links = [
  [canonical, source],
  [resolve(homedir(), ".claude/skills/interviewer"), canonical],
  [resolve(homedir(), ".codex/skills/interviewer"), canonical],
  [resolve(homedir(), ".pi/agent/skills/interviewer"), canonical],
];
const unlink = process.argv.includes("--unlink"); // Remove only links created by this script.

const orderedLinks = unlink ? [...links].reverse() : links;
for (const [link, target] of orderedLinks) {
  if (unlink) {
    if (isExpectedLink(link, target)) {
      rmSync(link);
      console.log(`removed ${link}`);
    }
    continue;
  }
  mkdirSync(dirname(link), { recursive: true });
  if (isExpectedLink(link, target)) {
    console.log(`ok ${link}`);
    continue;
  }
  try {
    lstatSync(link);
    throw new Error(`Refusing to replace existing path: ${link}`);
  } catch (error) {
    if (error instanceof Error && !("code" in error && error.code === "ENOENT"))
      throw error;
  }
  symlinkSync(target, link, "dir");
  console.log(`linked ${link} -> ${target}`);
}

function isExpectedLink(link, target) {
  try {
    return (
      lstatSync(link).isSymbolicLink() &&
      resolve(dirname(link), readlinkSync(link)) === resolve(target)
    );
  } catch {
    return false;
  }
}
