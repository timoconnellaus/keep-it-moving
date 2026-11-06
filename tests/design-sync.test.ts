import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyWrites,
  defaultPath,
  keepRefusal,
  kimPath,
  listKimFiles,
  planWrites,
  pullItem,
  slug,
  type KeptItem,
} from "../src/designSync.js";

const SESSION = {
  id: "s",
  title: "System design canvases",
  createdAt: "2026-11-06T00:58:55.925Z",
};
const SCHEMA = "Table users {\n  id uuid [pk]\n}\n";

let root: string;
const write = (path: string, content: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
};
const read = (path: string) => readFileSync(join(root, path), "utf8");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kim-sync-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git(
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=T",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "start",
  );
  write(".kim/designs/data-model.dbml", SCHEMA);
  write(".kim/designs/data-model.svg", "<svg/>");
  write(".kim/plans/2026-10-29-canvas-tabs.md", "# Canvas tabs");
  write(".kim/mockups/landing.html", "<!doctype html><html></html>");
  write(".kim/designs/notes.txt", "scratch");
  write(".kim/kim.json", "{}");
});

const kept = (overrides: Partial<KeptItem>): KeptItem => ({
  id: "a1b2c3d4-0000",
  kind: "design",
  designType: "data-model",
  title: "Interviews schema",
  content: SCHEMA,
  repo: null,
  ...overrides,
});

describe("the .kim/ folder", () => {
  it("lists what an interview could pull, without previews or settings", () => {
    expect(listKimFiles(root)).toEqual([
      {
        path: ".kim/designs/data-model.dbml",
        kind: "design",
        designType: "data-model",
      },
      { path: ".kim/designs/notes.txt", kind: "document" },
      { path: ".kim/mockups/landing.html", kind: "mockup" },
      { path: ".kim/plans/2026-10-29-canvas-tabs.md", kind: "document" },
    ]);
  });

  it("only takes paths inside .kim/", () => {
    expect(kimPath(root, join(root, ".kim"), "designs/data-model.dbml")).toBe(
      ".kim/designs/data-model.dbml",
    );
    expect(() => kimPath(root, root, "src/cli.ts")).toThrow(/\.kim\//);
    expect(() => kimPath(root, root, ".kim/../package.json")).toThrow();
  });

  it("pulls a file as a copy that remembers where and when it came from", () => {
    const item = pullItem(root, ".kim/designs/data-model.dbml");
    expect(item).toMatchObject({
      kind: "design",
      designType: "data-model",
      title: "Data model",
      content: SCHEMA,
      repo: { path: ".kim/designs/data-model.dbml", baseContent: SCHEMA },
    });
    expect(item.repo.baseCommit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("writing back", () => {
  it("names new items after their title, and the plan after the interview", () => {
    expect(defaultPath(kept({}), SESSION)).toBe(
      ".kim/designs/interviews-schema.dbml",
    );
    expect(
      defaultPath(
        kept({ designType: "data-flow", title: "Checkout" }),
        SESSION,
      ),
    ).toBe(".kim/designs/checkout.data-flow.d2");
    expect(defaultPath(kept({ kind: "plan", title: "Plan" }), SESSION)).toBe(
      ".kim/plans/2026-11-06-system-design-canvases.md",
    );
    expect(
      defaultPath(kept({ kind: "mockup", title: "Pricing page" }), SESSION),
    ).toBe(".kim/mockups/pricing-page.html");
    expect(slug("  Ünïcode & Things!  ")).toBe("unicode-things");
  });

  it("never rewrites a past plan, and keeps only what belongs in .kim/", () => {
    expect(
      keepRefusal({
        kind: "document",
        title: "Canvas tabs",
        repo: { path: ".kim/plans/2026-10-29-canvas-tabs.md" },
      }),
    ).toMatch(/past plan/);
    expect(
      keepRefusal({ kind: "document", title: "Notes", repo: null }),
    ).toMatch(/keeps designs/);
    expect(keepRefusal({ kind: "plan", title: "Plan", repo: null })).toBeNull();
  });

  it("updates files the interview copied, creates new ones, and skips the same", () => {
    const changed = `${SCHEMA}Table plans {\n  id uuid\n}\n`;
    const steps = planWrites(root, SESSION, [
      kept({
        content: changed,
        repo: {
          path: ".kim/designs/data-model.dbml",
          baseCommit: null,
          baseContent: SCHEMA,
        },
      }),
      kept({ id: "plan", kind: "plan", title: "Plan", content: "# Plan" }),
      kept({
        id: "same",
        title: "Landing",
        kind: "mockup",
        content: "<!doctype html><html></html>",
        repo: {
          path: ".kim/mockups/landing.html",
          baseCommit: null,
          baseContent: "<!doctype html><html></html>",
        },
      }),
    ]);
    expect(steps.map((step) => [step.path, step.action])).toEqual([
      [".kim/designs/data-model.dbml", "update"],
      [".kim/plans/2026-11-06-system-design-canvases.md", "create"],
      [".kim/mockups/landing.html", "unchanged"],
    ]);
    const result = applyWrites(root, steps);
    expect(result.conflicts).toEqual([]);
    expect(result.written.map((step) => step.path)).toEqual([
      ".kim/designs/data-model.dbml",
      ".kim/plans/2026-11-06-system-design-canvases.md",
    ]);
    expect(read(".kim/designs/data-model.dbml")).toBe(changed);
    expect(read(".kim/plans/2026-11-06-system-design-canvases.md")).toBe(
      "# Plan",
    );
  });

  it("writes nothing when a file changed since the copy, and saves the three versions", () => {
    const theirs = `${SCHEMA}// from main\n`;
    write(".kim/designs/data-model.dbml", theirs);
    const steps = planWrites(root, SESSION, [
      kept({
        content: `${SCHEMA}// ours\n`,
        repo: {
          path: ".kim/designs/data-model.dbml",
          baseCommit: null,
          baseContent: SCHEMA,
        },
      }),
      kept({ id: "plan", kind: "plan", title: "Plan", content: "# Plan" }),
    ]);
    expect(steps.map((step) => step.action)).toEqual(["conflict", "create"]);
    const { written, conflicts } = applyWrites(root, steps);
    expect(written).toEqual([]);
    expect(read(".kim/designs/data-model.dbml")).toBe(theirs);
    expect(conflicts).toHaveLength(1);
    const [conflict] = conflicts;
    expect(readFileSync(conflict!.ours, "utf8")).toBe(`${SCHEMA}// ours\n`);
    expect(readFileSync(conflict!.theirs, "utf8")).toBe(theirs);
    expect(readFileSync(conflict!.base!, "utf8")).toBe(SCHEMA);
  });

  it("treats a new item landing on an existing file as a conflict", () => {
    const steps = planWrites(root, SESSION, [
      kept({ title: "Data model", content: "Table other {}" }),
    ]);
    expect(steps[0]).toMatchObject({
      path: ".kim/designs/data-model.dbml",
      action: "conflict",
      base: null,
    });
  });

  it("refuses two items bound for the same file", () => {
    expect(() =>
      planWrites(root, SESSION, [
        kept({ id: "1", title: "Schema" }),
        kept({ id: "2", title: "schema" }),
      ]),
    ).toThrow(/both be written to \.kim\/designs\/schema\.dbml/);
  });
});
