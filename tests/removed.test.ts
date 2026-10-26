import { afterEach, describe, expect, it } from "vitest";
import { hubHarness } from "./helpers/harness.js";

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((close) => close()));

describe("what Keep it moving no longer does", () => {
  it("answers 404 for the inbox, projects, PRs, automations, backlog and agent sessions", async () => {
    const { app, sql } = hubHarness();
    closers.push(() => sql.close());
    for (const [method, url] of [
      ["GET", "/api/browser/kim/inbox"],
      ["GET", "/api/browser/kim/projects"],
      ["GET", "/api/browser/kim/projects/p1/sessions"],
      ["GET", "/api/browser/kim/prs?project=github.com/o/r"],
      ["GET", "/api/sessions/kim/inbox"],
      ["POST", "/api/sessions/kim/report"],
      ["POST", "/api/sessions/kim/heartbeat"],
      ["POST", "/api/sessions/kim/machines/beat"],
      ["GET", "/api/sessions/kim/automations"],
      ["GET", "/api/sessions/kim/prs?project=github.com/o/r"],
      ["GET", "/api/sessions/kim/backlog?project=github.com/o/r"],
      ["POST", "/api/sessions/kim/backlog/sync"],
      ["POST", "/api/sessions/kim/followups"],
      ["GET", "/api/sessions/kim/projects/context?project=github.com/o/r"],
      ["POST", "/api/sessions/kim/projects/summary"],
      ["POST", "/api/sessions/projects/update"],
    ] as const)
      expect(
        (
          await app.inject({
            method,
            url,
            ...(method === "POST" ? { payload: {} } : {}),
          })
        ).statusCode,
        `${method} ${url}`,
      ).toBe(404);
  });

  it("no longer creates the inbox's own table", () => {
    const { sql } = hubHarness();
    closers.push(() => sql.close());
    expect(
      sql.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kim_inbox_seen'",
      ),
    ).toEqual([]);
  });
});
