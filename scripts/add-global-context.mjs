#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const instruction =
  "When /grill-me is invoked, use the interviewer skill and CLI to conduct the grilling interview.";
const files = [
  resolve(homedir(), ".claude/CLAUDE.md"),
  resolve(homedir(), ".codex/AGENTS.md"),
  resolve(homedir(), ".pi/agent/AGENTS.md"),
];
for (const file of files) {
  mkdirSync(dirname(file), { recursive: true });
  const content = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!content.includes(instruction))
    appendFileSync(
      file,
      `${content && !content.endsWith("\n") ? "\n" : ""}\n${instruction}\n`,
    );
  console.log(`ok ${file}`);
}
