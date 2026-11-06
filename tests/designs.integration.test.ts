import { describe, expect, it } from "vitest";
import { designTypeOf } from "../src/designFiles.js";
import { designPage } from "../src/server/designPage.js";
import { hubHarness } from "./helpers/harness.js";

const SCHEMA = `Table users {
  id uuid [pk]
  email text
}`;
const CHANGED = `${SCHEMA.slice(0, -1)}  plan text
}`;

async function interview() {
  const { app } = hubHarness();
  const session = (
    await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "Schema" },
    })
  ).json();
  const add = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/artifacts`,
      payload,
    });
  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/artifacts/${id}`,
      payload,
    });
  const view = (id: string) =>
    app.inject({
      method: "GET",
      url: `/api/browser/${session.token}/artifacts/${id}/view`,
    });
  const browser = async () =>
    (
      await app.inject({
        method: "GET",
        url: `/api/browser/${session.token}/session`,
      })
    ).json();
  return { session, add, patch, view, browser };
}

describe("system designs", () => {
  it("needs a design type, and only a design has one", async () => {
    const { add } = await interview();
    const missing = await add({
      kind: "design",
      title: "Schema",
      content: SCHEMA,
    });
    expect(missing.statusCode).toBe(400);
    const misplaced = await add({
      kind: "document",
      designType: "data-model",
      title: "Notes",
      content: "# Notes",
    });
    expect(misplaced.statusCode).toBe(400);
  });

  it("serves a design as the viewer's page, with its repo copy to compare", async () => {
    const { add, view, browser } = await interview();
    const design = (
      await add({
        kind: "design",
        designType: "data-model",
        title: "Interviews schema",
        content: CHANGED,
        repo: {
          path: ".kim/designs/data-model.dbml",
          baseCommit: "8149a37",
          baseContent: SCHEMA,
        },
        keep: true,
      })
    ).json();
    expect(design).toMatchObject({
      kind: "design",
      format: "html",
      designType: "data-model",
      keep: true,
      repo: {
        path: ".kim/designs/data-model.dbml",
        baseCommit: "8149a37",
        changed: true,
      },
    });
    const page = (await view(design.id)).body;
    expect(page).toContain('src="/design-viewer/viewer.js"');
    const data = JSON.parse(
      /<script type="application\/json" id="kim-design">(.*?)<\/script>/s.exec(
        page,
      )![1]!,
    );
    expect(data).toEqual({
      type: "data-model",
      title: "Interviews schema",
      source: CHANGED,
      base: SCHEMA,
    });
    // The page loads it by URL; the state carries no repo content.
    const state = await browser();
    expect(JSON.stringify(state)).not.toContain("baseContent");
  });

  it("marks a design kept without making a new revision", async () => {
    const { add, patch, browser } = await interview();
    const design = (
      await add({
        kind: "design",
        designType: "sequence",
        title: "Pull a design",
        content: "sequenceDiagram\n  Agent->>kim: pull",
      })
    ).json();
    expect(design).toMatchObject({ keep: false, revision: 1 });
    expect(design.repo).toBeUndefined();
    const kept = (await patch(design.id, { keep: true })).json();
    expect(kept).toMatchObject({ keep: true, revision: 1 });
    const state = await browser();
    expect(
      state.artifacts.find((item: { id: string }) => item.id === design.id),
    ).toMatchObject({ keep: true });
  });

  it("says a design is unchanged when it matches its repo copy", async () => {
    const { add } = await interview();
    const design = (
      await add({
        kind: "design",
        designType: "data-model",
        title: "Schema",
        content: SCHEMA,
        repo: { path: ".kim/designs/data-model.dbml", baseContent: SCHEMA },
      })
    ).json();
    expect(design.repo).toEqual({
      path: ".kim/designs/data-model.dbml",
      baseCommit: null,
      pulled: true,
      changed: false,
    });
  });

  it("refuses a repo path outside the repo", async () => {
    const { add } = await interview();
    for (const path of ["/etc/passwd", "../elsewhere/x.dbml", ".kim/../../x"])
      expect(
        (
          await add({
            kind: "design",
            designType: "data-model",
            title: "Schema",
            content: SCHEMA,
            repo: { path },
          })
        ).statusCode,
      ).toBe(400);
  });
});

describe("design files", () => {
  it("knows a design's type from its name and content", () => {
    expect(designTypeOf("schema.dbml", "")).toBe("data-model");
    expect(designTypeOf(".kim/designs/system.d2", "")).toBe("architecture");
    expect(designTypeOf("checkout.data-flow.d2", "")).toBe("data-flow");
    expect(designTypeOf("login.mmd", "%% note\nsequenceDiagram\n")).toBe(
      "sequence",
    );
    expect(designTypeOf("order.mmd", "stateDiagram-v2\n")).toBe("state");
    expect(designTypeOf("flow.mmd", "flowchart LR\n")).toBeNull();
    expect(designTypeOf("api.yaml", "openapi: 3.1.0\n")).toBe("api");
    expect(designTypeOf("config.yaml", "name: app\n")).toBeNull();
    expect(designTypeOf("page.html", "<html>")).toBeNull();
  });
});

describe("the design page", () => {
  it("keeps the source from closing its script element", () => {
    const page = designPage({
      type: "api",
      title: "<API>",
      source: "description: </script><script>alert(1)</script>",
      base: null,
    });
    expect(page).not.toContain("</script><script>alert");
    expect(page).toContain("<title>&lt;API&gt;</title>");
  });
});
