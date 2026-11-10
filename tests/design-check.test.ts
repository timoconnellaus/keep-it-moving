import { describe, expect, it } from "vitest";
import { designProblem } from "../src/designCheck.js";

describe("designProblem", () => {
  it("passes designs that draw", async () => {
    const good = {
      "data-model": "Table users {\n  id int [pk]\n}\n",
      architecture: "web -> api: calls\napi -> db\n",
      "data-flow": "events -> warehouse -> dashboards\n",
      sequence: "sequenceDiagram\n  A->>B: hi\n",
      state: "stateDiagram-v2\n  [*] --> Draft\n  Draft --> Sent\n",
      api: "openapi: 3.0.0\ninfo: {title: T, version: '1'}\npaths:\n  /a:\n    get:\n      responses: {'200': {description: ok}}\n",
    } as const;
    for (const [type, source] of Object.entries(good))
      expect(
        await designProblem(type as keyof typeof good, source),
        type,
      ).toBeNull();
  }, 30_000);

  it("names the line of a DBML error", async () => {
    const problem = await designProblem(
      "data-model",
      "Table users {\n  id int [pk]\n}\nRef: users.id > orders.user_id\n",
    );
    expect(problem?.line).toBe(4);
  });

  it("names the line of a D2 error", async () => {
    const problem = await designProblem("architecture", "a -> b\nc ->\n");
    expect(problem).toMatchObject({ line: 2 });
    expect(problem?.message).toContain("connection missing destination");
  }, 30_000);

  it("names the line of a Mermaid error", async () => {
    const problem = await designProblem(
      "sequence",
      "sequenceDiagram\n  A->>: hi\n",
    );
    expect(problem?.line).toBe(2);
  });

  it("refuses a Mermaid diagram of the wrong kind", async () => {
    const problem = await designProblem(
      "sequence",
      "stateDiagram-v2\n  [*] --> A\n",
    );
    expect(problem?.message).toContain("sequenceDiagram");
  });

  it("reports a YAML error in an API design", async () => {
    const problem = await designProblem("api", "openapi: 3.0.0\npaths: [\n");
    expect(problem).not.toBeNull();
  });
});
