import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The interviewer skill, installed once and linked into each agent that
 * should see it: one canonical copy in ~/.agents/skills/interviewer, and a
 * symlink to it from each chosen agent's skills folder, so refreshing the
 * copy updates them all. It only ever replaces or removes what it made.
 */

/** The agents a skill can be linked into, by the folder in ~ that shows they're installed. */
export const SKILL_AGENTS = [
  { id: "claude", name: "Claude Code", home: ".claude" },
  { id: "codex", name: "Codex", home: ".codex" },
  { id: "pi", name: "Pi", home: ".pi/agent" },
] as const;
export type AgentId = (typeof SKILL_AGENTS)[number]["id"];

/** Marks the canonical copy as ours, and holds the hash of what was copied. */
export const SKILL_MARKER = ".installed-by-kim";

export interface SkillPaths {
  /** The user's home folder. */
  home: string;
  /** The skill this CLI ships with. */
  source: string;
  /** Where the agents chosen at install are remembered. */
  choiceFile: string;
}

export const canonicalSkill = (home: string) =>
  join(home, ".agents", "skills", "interviewer");
const agentSkill = (home: string, agent: (typeof SKILL_AGENTS)[number]) =>
  join(home, agent.home, "skills", "interviewer");

/** The agents whose folder exists, so they're probably installed. */
export function installedAgents(home: string): AgentId[] {
  return SKILL_AGENTS.filter((agent) => existsSync(join(home, agent.home))).map(
    (agent) => agent.id,
  );
}

/** "claude,codex" → ["claude", "codex"], or an error naming what's unknown. */
export function parseAgents(list: string): AgentId[] {
  const ids = list
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const known = new Set<string>(SKILL_AGENTS.map((agent) => agent.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length || !ids.length)
    throw new Error(
      `Unknown agent ${unknown.join(", ") || "(none)"}: choose from ${[...known].join(", ")}`,
    );
  return [...new Set(ids)] as AgentId[];
}

export function rememberedAgents(choiceFile: string): AgentId[] | null {
  try {
    const { agents } = JSON.parse(readFileSync(choiceFile, "utf8")) as {
      agents?: string[];
    };
    return agents ? parseAgents(agents.join(",")) : null;
  } catch {
    return null;
  }
}

/** A hash of every file in the skill folder, by path and content. */
export function skillHash(dir: string): string {
  const hash = createHash("sha256");
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (entry.name === SKILL_MARKER) continue;
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
  return hash.digest("hex");
}

type Kind = "missing" | "ours" | "our-link" | "other-link" | "other";

/** What is at `path`, relative to the canonical copy at `canonical`. */
function kindOf(path: string, canonical: string): Kind {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "missing";
  }
  if (stat.isSymbolicLink())
    return resolve(dirname(path), readlinkSync(path)) === canonical
      ? "our-link"
      : "other-link";
  return stat.isDirectory() && existsSync(join(path, SKILL_MARKER))
    ? "ours"
    : "other";
}

/** Removes what's at `path`; a symlink itself, never what it points to. */
function remove(path: string, kind: Kind) {
  if (kind === "our-link" || kind === "other-link") unlinkSync(path);
  else if (kind !== "missing") rmSync(path, { recursive: true, force: true });
}

function copySkill(source: string, canonical: string) {
  cpSync(source, canonical, { recursive: true });
  writeFileSync(
    join(canonical, SKILL_MARKER),
    `${JSON.stringify({ hash: skillHash(source), source })}\n`,
  );
}

export interface InstallResult {
  canonical: string;
  agents: AgentId[];
  linked: string[];
  unlinked: string[];
  skipped: Array<{ path: string; reason: string }>;
}

const refusal = (kind: Kind) =>
  `${kind === "other-link" ? "a symlink" : "a folder"} kim didn't make; pass --force to replace it`;

/**
 * Copies the skill to the canonical folder and links it into each of
 * `agents`, removing our links from the others. Replaces a link or folder
 * it didn't make only with `force`; without the canonical copy, it links
 * nothing.
 */
export function installSkill(
  paths: SkillPaths,
  agents: AgentId[],
  force = false,
): InstallResult {
  const { home, source } = paths;
  if (!existsSync(join(source, "SKILL.md")))
    throw new Error(`The bundled skill is missing: ${source}`);
  const canonical = canonicalSkill(home);
  const result: InstallResult = {
    canonical,
    agents,
    linked: [],
    unlinked: [],
    skipped: [],
  };
  const kind = kindOf(canonical, canonical);
  if ((kind === "other" || kind === "other-link") && !force) {
    result.skipped.push({ path: canonical, reason: refusal(kind) });
    return result;
  }
  remove(canonical, kind);
  mkdirSync(dirname(canonical), { recursive: true });
  copySkill(source, canonical);

  for (const agent of SKILL_AGENTS) {
    const link = agentSkill(home, agent);
    const kind = kindOf(link, canonical);
    if (!agents.includes(agent.id)) {
      if (kind === "our-link") {
        unlinkSync(link);
        result.unlinked.push(link);
      }
      continue;
    }
    if (kind === "our-link") {
      result.linked.push(link);
      continue;
    }
    if (kind !== "missing" && !force) {
      result.skipped.push({ path: link, reason: refusal(kind) });
      continue;
    }
    remove(link, kind);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(canonical, link, "dir");
    result.linked.push(link);
  }
  mkdirSync(dirname(paths.choiceFile), { recursive: true });
  writeFileSync(paths.choiceFile, `${JSON.stringify({ agents })}\n`);
  return result;
}

/** Removes our links and our canonical copy, and forgets the chosen agents. */
export function uninstallSkill(paths: SkillPaths): { removed: string[] } {
  const canonical = canonicalSkill(paths.home);
  const removed: string[] = [];
  for (const agent of SKILL_AGENTS) {
    const link = agentSkill(paths.home, agent);
    if (kindOf(link, canonical) !== "our-link") continue;
    unlinkSync(link);
    removed.push(link);
  }
  if (kindOf(canonical, canonical) === "ours") {
    rmSync(canonical, { recursive: true, force: true });
    removed.push(canonical);
  }
  rmSync(paths.choiceFile, { force: true });
  return { removed };
}

/**
 * Brings our canonical copy up to date with the bundled skill when they
 * differ; the agents' links then see it. Cheap enough for every run: one
 * small marker file read, and a hash of the bundled skill.
 */
export function refreshSkill(paths: SkillPaths): boolean {
  const canonical = canonicalSkill(paths.home);
  if (kindOf(canonical, canonical) !== "ours") return false;
  if (!existsSync(join(paths.source, "SKILL.md"))) return false;
  let installed: string | undefined;
  try {
    installed = (
      JSON.parse(readFileSync(join(canonical, SKILL_MARKER), "utf8")) as {
        hash?: string;
      }
    ).hash;
  } catch {
    // An unreadable marker is still ours: rewrite it.
  }
  if (installed === skillHash(paths.source)) return false;
  rmSync(canonical, { recursive: true, force: true });
  copySkill(paths.source, canonical);
  return true;
}
