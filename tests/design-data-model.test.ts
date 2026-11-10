import { describe, expect, it } from "vitest";
import {
  diffDataModel,
  parseDataModel,
  relationName,
} from "../src/design/dataModel.js";
import { SAMPLES } from "../src/design/dev/samples.js";
import { describeError } from "../src/design/errors.js";
import { erdSvg } from "../src/design/erd.js";

const base = `Table users {
  id uuid [pk]
  email text [not null]
  plan text
}
Table posts {
  id int [pk, increment]
  user_id uuid [ref: > users.id]
  body text
}
Table old_things { id int }
`;
const current = `Table users {
  id uuid [pk]
  email varchar(255) [not null, unique]
  name text
}
Table posts {
  id int [pk, increment]
  user_id uuid [ref: > users.id]
  body text
}
Table comments {
  id int [pk]
  post_id int [ref: > posts.id]
}
Enum status {
  draft
  live
}
`;

describe("parseDataModel", () => {
  it("reads tables, fields, enums and relations", () => {
    const model = parseDataModel(current);
    expect(model.tables.map((t) => `${t.kind}:${t.name}`)).toEqual([
      "table:users",
      "table:posts",
      "table:comments",
      "enum:status",
    ]);
    const email = model.tables[0]!.fields[1]!;
    expect(email).toMatchObject({
      name: "email",
      type: "varchar(255)",
      notNull: true,
      unique: true,
      pk: false,
    });
    const userId = model.tables[1]!.fields[1]!;
    expect(userId).toMatchObject({ fk: true, pk: false });
    expect(model.relations).toHaveLength(2);
    const rel = model.relations.find(
      (r) => r.from.table === "posts" && r.to.table === "users",
    )!;
    expect(rel.from).toEqual({
      table: "posts",
      fields: ["user_id"],
      cardinality: "n",
    });
    expect(rel.to).toEqual({
      table: "users",
      fields: ["id"],
      cardinality: "1",
    });
    expect(relationName(rel)).toBe("users → posts relation");
  });

  it("marks composite primary keys and reads notes", () => {
    const model = parseDataModel(`Table t {
  a int
  b int [note: 'the b']
  indexes { (a, b) [pk] }
  Note: 'pairs'
}`);
    expect(model.tables[0]!.fields.map((f) => f.pk)).toEqual([true, true]);
    expect(model.tables[0]!.fields[1]!.note).toBe("the b");
    expect(model.tables[0]!.note).toBe("pairs");
  });

  it("throws with the line and column of the error", () => {
    let error: unknown;
    try {
      parseDataModel("Table x {\n  id int [pk\n}\n");
    } catch (e) {
      error = e;
    }
    expect(describeError(error)).toMatchObject({ line: 3, column: 1 });
  });

  it("parses the repo sample", () => {
    expect(
      parseDataModel(SAMPLES["data-model"]!.source).tables.length,
    ).toBeGreaterThan(5);
  });
});

describe("diffDataModel", () => {
  const diff = diffDataModel(parseDataModel(base), parseDataModel(current));
  const status = (name: string) =>
    diff.tables.find((t) => t.table.name === name)?.status;

  it("marks tables added, changed, removed and same", () => {
    expect(status("comments")).toBe("added");
    expect(status("status")).toBe("added");
    expect(status("old_things")).toBe("removed");
    expect(status("users")).toBe("changed");
    expect(status("posts")).toBe("same");
  });

  it("marks fields, with type and setting changes as changed", () => {
    const users = diff.tables.find((t) => t.table.name === "users")!;
    expect(users.fields.map((f) => `${f.item.name}:${f.status}`)).toEqual([
      "id:same",
      "email:changed",
      "plan:removed",
      "name:added",
    ]);
  });

  it("keeps removed tables in the drawing", () => {
    expect(diff.tables.map((t) => t.table.name)).toContain("old_things");
  });

  it("counts a new table once, plus each field and relation change", () => {
    // added: comments, status, name, comments→posts relation
    // changed: email; removed: old_things, plan
    expect(diff.counts).toEqual({ added: 4, changed: 1, removed: 2 });
  });

  it("finds nothing when the two match", () => {
    expect(
      diffDataModel(parseDataModel(base), parseDataModel(base)).counts,
    ).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
    });
  });
});

describe("erdSvg", () => {
  const diff = diffDataModel(parseDataModel(base), parseDataModel(current));
  it("names every table, field and relation for pins", () => {
    const svg = erdSvg(diff, { compare: true });
    expect(svg).toContain('data-name="users table"');
    expect(svg).toContain('data-name="users.email field"');
    expect(svg).toContain('data-name="status.draft value"');
    expect(svg).toContain('data-name="posts → comments relation"');
    expect(svg).toContain('class="card removed"');
  });
  it("marks changed tables, fields and relations for the viewer", () => {
    const svg = erdSvg(diff, { compare: true });
    expect(svg).toMatch(/data-name="[^"]+ table" data-kim-status="removed"/);
    expect(svg).toMatch(/data-kim-status="added"/);
    expect(erdSvg(diff, { compare: false })).not.toContain("data-kim-status");
  });
  it("draws no highlights with compare off", () => {
    const svg = erdSvg(diff, { compare: false });
    expect(svg).not.toMatch(
      /class="(card|row|rel)[^"]*(added|changed|removed)/,
    );
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(
      true,
    );
  });
});
