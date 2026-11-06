import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DESIGN_EXTENSIONS, designTypeOf } from "./designFiles.js";
import type { DesignType } from "./shared/designs.js";

/** The folder in a repo that holds what interviews pull from and write to. */
export const KIM_DIR = ".kim";
/** Plans record what was decided then: later interviews read them, never rewrite them. */
export const PLANS_DIR = `${KIM_DIR}/plans/`;

type Kind = "plan" | "document" | "diagram" | "mockup" | "design" | "tokens";

/** The design system's tokens, which mockups link to use them. */
export const TOKENS_PATH = `${KIM_DIR}/design-system/tokens.css`;

/** Where an artifact came from in the repo, with its content then. */
export interface RepoOrigin {
  path: string;
  baseCommit: string | null;
  baseContent: string | null;
}

/** An artifact as `kim design write` gets it from the interview. */
export interface KeptItem {
  id: string;
  kind: Kind;
  title: string;
  designType?: DesignType;
  content: string;
  repo: RepoOrigin | null;
}

/** The interview the items belong to. */
export interface KeptSession {
  id: string;
  title: string;
  createdAt: string;
}

/** A repo file as an artifact to add to an interview. */
export interface PulledItem {
  kind: Kind;
  designType?: DesignType;
  title: string;
  content: string;
  repo: RepoOrigin;
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    return (
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** The root of the repo a directory is in, or null outside one. */
export function repoRoot(cwd: string): string | null {
  return git(cwd, "rev-parse", "--show-toplevel");
}

/**
 * A path in the repo as kim stores it: relative to the root, with forward
 * slashes, and inside .kim/. Paths given relative to the current directory
 * work too.
 */
export function kimPath(root: string, cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  const inRepo = relative(root, absolute).split(sep).join("/");
  if (!inRepo.startsWith(`${KIM_DIR}/`) || inRepo.split("/").includes(".."))
    throw new Error(
      `${path} isn't in the repo's ${KIM_DIR}/ folder; designs, mockups, the design system and plans live there`,
    );
  return inRepo;
}

const titleFrom = (path: string) => {
  const name = path
    .split("/")
    .pop()!
    .replace(/\.[^.]+$/, "");
  const words = name.replace(/\.[a-z-]+$/, "").replace(/[-_.]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * What a file in .kim/ becomes in an interview: a design, a mockup (any
 * html, including the design system's component gallery), or a document
 * (Markdown such as a past plan or the design system's README).
 */
export function itemFor(
  path: string,
  content: string,
): { kind: Kind; designType?: DesignType } {
  const designType = designTypeOf(path, content);
  if (designType) return { kind: "design", designType };
  if (/\.html?$/i.test(path)) return { kind: "mockup" };
  if (/\.css$/i.test(path)) return { kind: "tokens" };
  if (/\.(md|markdown|txt)$/i.test(path)) return { kind: "document" };
  throw new Error(
    `kim doesn't know what ${path} is; it reads .dbml, .d2, .mmd, OpenAPI .yaml, .html, .css and .md files`,
  );
}

/** Reads a file from .kim/ as an interview artifact, remembering where and when it came from. */
export function pullItem(root: string, path: string): PulledItem {
  const file = join(root, path);
  if (!existsSync(file)) throw new Error(`${path} doesn't exist`);
  const content = readFileSync(file, "utf8");
  return {
    ...itemFor(path, content),
    title: titleFrom(path),
    content,
    repo: {
      path,
      baseCommit: git(root, "rev-parse", "HEAD"),
      baseContent: content,
    },
  };
}

/** Whether a page links the design system's tokens. */
export const linksTokens = (html: string) =>
  /<link\b[^>]*\bhref\s*=\s*["']?[^"'>\s]*design-system\/tokens\.css/i.test(
    html,
  );

/** Everything in .kim/ an interview could pull, for the agent to choose from. */
export function listKimFiles(
  root: string,
): Array<{ path: string; kind: Kind; designType?: DesignType }> {
  const found: Array<{ path: string; kind: Kind; designType?: DesignType }> =
    [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const path = relative(root, full).split(sep).join("/");
      // A design's rendered preview goes with it; the design is the source.
      if (name.endsWith(".svg") || path === `${KIM_DIR}/kim.json`) continue;
      try {
        const item = itemFor(path, readFileSync(full, "utf8"));
        found.push({ path, ...item });
      } catch {
        // Not something an interview shows.
      }
    }
  };
  walk(join(root, KIM_DIR));
  return found;
}

/** A name for a file: lowercase words joined by hyphens. */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 60)
      .replace(/-+$/, "") || "untitled"
  );
}

/** Where a kept item goes when it didn't come from the repo. */
export function defaultPath(item: KeptItem, session: KeptSession): string {
  if (item.kind === "plan")
    return `${PLANS_DIR}${session.createdAt.slice(0, 10)}-${slug(session.title)}.md`;
  if (item.kind === "design" && item.designType) {
    const extension = DESIGN_EXTENSIONS[item.designType];
    // A D2 file is architecture unless its name says otherwise.
    const typed = item.designType === "data-flow" ? `.${item.designType}` : "";
    return `${KIM_DIR}/designs/${slug(item.title)}${typed}.${extension}`;
  }
  if (item.kind === "mockup")
    return `${KIM_DIR}/mockups/${slug(item.title)}.html`;
  throw new Error(
    `"${item.title}" is a ${item.kind}; kim writes designs, mockups and the plan to ${KIM_DIR}/`,
  );
}

/** Why an item can't be kept, or null when it can. */
export function keepRefusal(item: {
  kind: Kind;
  title: string;
  repo: { path: string } | null;
}): string | null {
  // A past plan comes in as a document; this interview's own plan may
  // have a path there too, once it has been written and rebased.
  if (item.kind !== "plan" && item.repo?.path.startsWith(PLANS_DIR))
    return `"${item.title}" is a past plan, which stays as it was decided; write what changed in this interview's plan`;
  if (item.repo) return null;
  if (["design", "mockup", "plan", "tokens"].includes(item.kind)) return null;
  return `"${item.title}" is a ${item.kind}; kim keeps designs, mockups, the plan, and files pulled from ${KIM_DIR}/`;
}

/** Where a design's rendered preview goes: beside it, as SVG. */
export function previewPath(path: string): string {
  return path.replace(/\.[^./]+$/, "") + ".svg";
}

/** What writing one kept item does to the repo. */
export interface WriteStep {
  artifactId: string;
  title: string;
  path: string;
  /**
   * create: a new file. update: the repo file is as the interview copied
   * it, so the interview's version replaces it. unchanged: the file
   * already says this. conflict: the file changed since the interview
   * copied it (or one exists where a new item would go).
   */
  action: "create" | "update" | "unchanged" | "conflict";
  content: string;
  /** For a conflict: what the file says now, and what the interview copied. */
  theirs?: string;
  base?: string | null;
}

/** Works out what writing the kept items would do, without writing anything. */
export function planWrites(
  root: string,
  session: KeptSession,
  items: KeptItem[],
): WriteStep[] {
  const steps: WriteStep[] = [];
  const claimed = new Map<string, string>();
  for (const item of items) {
    const refusal = keepRefusal(item);
    if (refusal) throw new Error(refusal);
    const path = item.repo?.path ?? defaultPath(item, session);
    const other = claimed.get(path);
    if (other)
      throw new Error(
        `"${item.title}" and "${other}" would both be written to ${path}; rename one`,
      );
    claimed.set(path, item.title);
    const file = join(root, path);
    const theirs = existsSync(file) ? readFileSync(file, "utf8") : null;
    const base = item.repo?.baseContent ?? null;
    const step = {
      artifactId: item.id,
      title: item.title,
      path,
      content: item.content,
    };
    if (theirs === null) steps.push({ ...step, action: "create" });
    else if (theirs === item.content)
      steps.push({ ...step, action: "unchanged" });
    else if (item.repo && theirs === base)
      steps.push({ ...step, action: "update" });
    else steps.push({ ...step, action: "conflict", theirs, base });
  }
  return steps;
}

/** Where a conflict's three versions were saved for the agent to merge. */
export interface ConflictFiles {
  artifactId: string;
  title: string;
  path: string;
  /** The interview's version. */
  ours: string;
  /** The repo file as it is now. */
  theirs: string;
  /** The repo file as the interview copied it; null for a new item. */
  base: string | null;
}

/**
 * Writes every step that isn't a conflict, and saves each conflict's
 * versions to a folder for the agent to merge. Nothing is written when
 * there is a conflict, so the repo never holds half of an interview.
 */
export function applyWrites(
  root: string,
  steps: WriteStep[],
): { written: WriteStep[]; conflicts: ConflictFiles[] } {
  const clashes = steps.filter((step) => step.action === "conflict");
  if (clashes.length) {
    const dir = mkdtempSync(join(tmpdir(), "kim-merge-"));
    const conflicts = clashes.map((step) => {
      const name = step.path.split("/").pop()!;
      const save = (label: string, content: string) => {
        const file = join(dir, step.artifactId.slice(0, 8), `${label}.${name}`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
        return file;
      };
      return {
        artifactId: step.artifactId,
        title: step.title,
        path: step.path,
        ours: save("ours", step.content),
        theirs: save("theirs", step.theirs!),
        base:
          step.base === null || step.base === undefined
            ? null
            : save("base", step.base),
      };
    });
    return { written: [], conflicts };
  }
  const written = steps.filter((step) => step.action !== "unchanged");
  for (const step of written) {
    const file = join(root, step.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, step.content);
  }
  return { written, conflicts: [] };
}
