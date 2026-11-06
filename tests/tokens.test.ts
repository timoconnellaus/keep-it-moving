import { describe, expect, it } from "vitest";
import {
  compareTokens,
  groupOf,
  parseTokens,
  tokensPage,
  usesTokens,
  withTokens,
} from "../src/server/tokensPage.js";
import { hubHarness } from "./helpers/harness.js";

const TOKENS = `/* Keep it moving */
:root {
  --ink: #0e0f11;
  --blue: #1f6bff;
  --font-display: "Outfit", sans-serif;
  --radius: 10px;
  --shadow-pop: 0 18px 44px -18px rgb(14 15 17 / 0.28);
}`;
const MOCKUP = `<!doctype html><html><head><link rel="stylesheet" href="../design-system/tokens.css"></head><body><button style="background:var(--blue)">Pay</button></body></html>`;

describe("design system tokens", () => {
  it("reads custom properties and groups them by what they set", () => {
    const tokens = parseTokens(TOKENS);
    expect(tokens.map((token) => token.name)).toEqual([
      "--ink",
      "--blue",
      "--font-display",
      "--radius",
      "--shadow-pop",
    ]);
    expect(tokens.map(groupOf)).toEqual([
      "colour",
      "colour",
      "type",
      "size",
      "shadow",
    ]);
  });

  it("compares them with the repo's", () => {
    const changes = compareTokens(
      parseTokens(":root{--blue:#4b3bff;--green:#2fbf71}"),
      parseTokens(":root{--blue:#1f6bff;--pink:#f2357b}"),
    );
    expect([...changes.added]).toEqual(["--green"]);
    expect([...changes.changed]).toEqual([["--blue", "#1f6bff"]]);
    expect(changes.removed.map((token) => token.name)).toEqual(["--pink"]);
  });

  it("draws a page that shows what changed, and names each token for comments", () => {
    const page = tokensPage(
      "Design system",
      TOKENS.replace("#1f6bff", "#4b3bff"),
      TOKENS,
    );
    expect(page).toContain('data-name="--blue token"');
    expect(page).toContain("<s>#1f6bff</s> → #4b3bff");
    expect(page).toContain("1 changed");
  });

  it("puts the tokens into a mockup in place of its link", () => {
    expect(usesTokens(MOCKUP)).toBe(true);
    expect(usesTokens("<html><body></body></html>")).toBe(false);
    const page = withTokens(MOCKUP, TOKENS);
    expect(page).not.toContain("tokens.css");
    expect(page).toContain("<style data-kim-tokens>");
    expect(page).toContain("--blue: #1f6bff");
  });
});

describe("a design system in an interview", () => {
  async function interview() {
    const { app } = hubHarness();
    const session = (
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Landing page" },
      })
    ).json();
    const add = async (payload: Record<string, unknown>) =>
      (
        await app.inject({
          method: "POST",
          url: `/api/sessions/${session.id}/artifacts`,
          payload,
        })
      ).json();
    const view = async (id: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/api/browser/${session.token}/artifacts/${id}/view`,
        })
      ).body;
    const browser = async () =>
      (
        await app.inject({
          method: "GET",
          url: `/api/browser/${session.token}/session`,
        })
      ).json();
    const patch = (id: string, payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/api/sessions/${session.id}/artifacts/${id}`,
        payload,
      });
    return { add, view, browser, patch };
  }

  it("draws a mockup with the interview's tokens, and reloads it when they change", async () => {
    const { add, view, browser, patch } = await interview();
    const mockup = await add({
      kind: "mockup",
      title: "Landing",
      content: MOCKUP,
    });
    // Without a design system the link stays, as written.
    expect(await view(mockup.id)).toContain("tokens.css");
    const tokens = await add({
      kind: "tokens",
      title: "Design system",
      content: TOKENS,
      repo: {
        path: ".kim/design-system/tokens.css",
        baseContent: TOKENS,
      },
    });
    expect(tokens).toMatchObject({ kind: "tokens", format: "html" });
    expect(await view(mockup.id)).toContain("--blue: #1f6bff");
    const before = (await browser()).artifacts.find(
      (item: { id: string }) => item.id === mockup.id,
    );
    expect(before.tokensRevision).toBe(1);

    await patch(tokens.id, { content: TOKENS.replace("#1f6bff", "#4b3bff") });
    expect(await view(mockup.id)).toContain("--blue: #4b3bff");
    const after = await browser();
    expect(
      after.artifacts.find((item: { id: string }) => item.id === mockup.id)
        .tokensRevision,
    ).toBe(2);
    expect(
      after.artifacts.find((item: { id: string }) => item.id === tokens.id)
        .repo,
    ).toMatchObject({ pulled: true, changed: true });
    expect(await view(tokens.id)).toContain("<s>#1f6bff</s> → #4b3bff");
  });
});
