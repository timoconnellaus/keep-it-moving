import { Compiler, DEFAULT_ENTRY, MemoryProjectLayout } from "@dbml/parse";
import { align, matchByKey, type Merged } from "./align.js";
import { DesignParseError } from "./errors.js";
import { count, noChanges, type ChangeCounts, type Status } from "./types.js";

/** A data model, parsed from DBML into what the entity diagram draws. */
export interface Field {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
  unique: boolean;
  notNull: boolean;
  increment: boolean;
  default: string | null;
  note: string | null;
}

export interface Table {
  /** Schema-qualified when not in the default schema. */
  name: string;
  kind: "table" | "enum";
  note: string | null;
  fields: Field[];
}

export type Cardinality = "1" | "n";

export interface Relation {
  /** Endpoints in a stable order, so `a > b` and `b < a` are one relation. */
  from: { table: string; fields: string[]; cardinality: Cardinality };
  to: { table: string; fields: string[]; cardinality: Cardinality };
}

export interface DataModel {
  tables: Table[];
  relations: Relation[];
}

type Note = string | { value?: string } | null | undefined;
interface DbmlField {
  name: string;
  type?: { type_name?: string; schemaName?: string | null };
  pk?: boolean;
  unique?: boolean;
  not_null?: boolean;
  increment?: boolean;
  note?: Note;
  dbdefault?: { value?: unknown; type?: string } | null;
}
/** The raw database @dbml/parse produces (the part we use). */
interface RawDatabase {
  tables: {
    name: string;
    schemaName?: string | null;
    note?: Note;
    fields: DbmlField[];
    indexes?: { pk?: boolean; columns?: { value: string; type?: string }[] }[];
  }[];
  enums: {
    name: string;
    schemaName?: string | null;
    note?: Note;
    values: { name: string; note?: Note }[];
  }[];
  refs: {
    endpoints: {
      tableName: string;
      schemaName?: string | null;
      fieldNames: string[];
      relation: string;
    }[];
  }[];
}

const noteText = (n: Note): string | null =>
  (typeof n === "string" ? n : n?.value) || null;

const qualify = (schema: string | null | undefined, name: string) =>
  schema && schema !== "public" ? `${schema}.${name}` : name;

const defaultText = (d: DbmlField["dbdefault"]): string | null => {
  if (!d || d.value === undefined || d.value === null) return null;
  const value = String(d.value);
  return d.type === "string"
    ? `'${value}'`
    : d.type === "expression"
      ? `\`${value}\``
      : value;
};

export const relationKey = (r: Relation) =>
  `${r.from.table}(${r.from.fields.join(",")}) ~ ${r.to.table}(${r.to.fields.join(",")})`;

/**
 * Parses DBML with @dbml/parse (the compiler behind @dbml/core's dbmlv2,
 * without its SQL importers). Throws a DesignParseError at the first error.
 */
export function parseDataModel(source: string): DataModel {
  const layout = new MemoryProjectLayout();
  layout.setSource(DEFAULT_ENTRY, source);
  const compiler = new Compiler(layout);
  const errors = compiler.parse.errors(DEFAULT_ENTRY);
  if (errors.length > 0) {
    const problems = errors.map((e) => ({
      message: e.diagnostic,
      line: e.nodeOrToken.startPos.line + 1,
      column: e.nodeOrToken.startPos.column + 1,
    }));
    throw new DesignParseError(
      problems.map((p) => p.message).join("\n"),
      problems[0]!.line,
      problems[0]!.column,
      problems,
    );
  }
  const database = compiler.parse.rawDb(
    DEFAULT_ENTRY,
  ) as unknown as RawDatabase;
  const tables: Table[] = [];
  const relations: Relation[] = [];
  const fkFields = new Set<string>();
  for (const ref of database.refs ?? []) {
    const [a, b] = ref.endpoints;
    if (!a || !b) continue;
    const end = (e: typeof a) => ({
      table: qualify(e.schemaName, e.tableName),
      fields: [...e.fieldNames],
      cardinality: (e.relation === "*" ? "n" : "1") as Cardinality,
    });
    let from = end(a);
    let to = end(b);
    // The many side holds the foreign key; with 1-1, the declaring side.
    for (const e of from.cardinality === "n"
      ? [from]
      : to.cardinality === "n"
        ? [to]
        : [from])
      for (const f of e.fields) fkFields.add(`${e.table}.${f}`);
    const keyOf = (e: typeof from) => `${e.table}(${e.fields.join(",")})`;
    if (keyOf(from) > keyOf(to)) [from, to] = [to, from];
    relations.push({ from, to });
  }
  for (const table of database.tables ?? []) {
    const compositePk = new Set(
      (table.indexes ?? [])
        .filter((i) => i.pk)
        .flatMap((i) =>
          (i.columns ?? [])
            .filter((c) => c.type !== "expression")
            .map((c) => c.value),
        ),
    );
    tables.push({
      name: qualify(table.schemaName, table.name),
      kind: "table",
      note: noteText(table.note),
      fields: table.fields.map((f) => ({
        name: f.name,
        type: f.type?.type_name ?? "",
        pk: Boolean(f.pk) || compositePk.has(f.name),
        fk: false,
        unique: Boolean(f.unique),
        notNull: Boolean(f.not_null),
        increment: Boolean(f.increment),
        default: defaultText(f.dbdefault),
        note: noteText(f.note),
      })),
    });
  }
  for (const e of database.enums ?? [])
    tables.push({
      name: qualify(e.schemaName, e.name),
      kind: "enum",
      note: noteText(e.note),
      fields: e.values.map((v) => ({
        name: v.name,
        type: "",
        pk: false,
        fk: false,
        unique: false,
        notNull: false,
        increment: false,
        default: null,
        note: noteText(v.note),
      })),
    });
  for (const t of tables)
    for (const f of t.fields)
      if (fkFields.has(`${t.name}.${f.name}`)) f.fk = true;
  return { tables, relations };
}

// fk follows the relations, which are compared on their own.
const fieldSignature = (f: Field) =>
  JSON.stringify([
    f.type,
    f.pk,
    f.unique,
    f.notNull,
    f.increment,
    f.default,
    f.note,
  ]);

export interface TableDiff {
  status: Status;
  table: Table;
  /** Table-level change (note or kind), apart from its fields. */
  ownChange: boolean;
  fields: Merged<Field>[];
}

export interface DataModelDiff {
  tables: TableDiff[];
  relations: Merged<Relation>[];
  counts: ChangeCounts;
}

/** Every table, field and relation as unchanged: the view without compare. */
export function plainDataModel(model: DataModel): DataModelDiff {
  return {
    tables: model.tables.map((table) => ({
      status: "same",
      table,
      ownChange: false,
      fields: table.fields.map((item) => ({
        status: "same",
        item,
        before: item,
      })),
    })),
    relations: model.relations.map((item) => ({
      status: "same",
      item,
      before: item,
    })),
    counts: noChanges(),
  };
}

/**
 * Compares tables and enums by name, their fields by name (a type or setting
 * change is a change), and relations by their endpoints (a cardinality change
 * is a change). A new or removed table counts once, not once per field.
 */
export function diffDataModel(
  base: DataModel,
  current: DataModel,
): DataModelDiff {
  const counts = noChanges();
  const tables = matchByKey(
    base.tables,
    current.tables,
    (t) => `${t.kind}:${t.name}`,
    () => true,
  ).map((entry): TableDiff => {
    const { item: table } = entry;
    if (entry.status === "added" || entry.status === "removed") {
      count(counts, entry.status);
      return {
        status: entry.status,
        table,
        ownChange: false,
        fields: table.fields.map((item) => ({ status: entry.status, item })),
      };
    }
    const before = entry.before!;
    const fields = align(before.fields, table.fields, (f) => f.name, {
      same: (x, y) => fieldSignature(x) === fieldSignature(y),
    });
    const ownChange = (before.note ?? "") !== (table.note ?? "");
    if (ownChange) counts.changed += 1;
    for (const f of fields) count(counts, f.status);
    const touched = ownChange || fields.some((f) => f.status !== "same");
    return { status: touched ? "changed" : "same", table, ownChange, fields };
  });
  const relations = matchByKey(
    base.relations,
    current.relations,
    relationKey,
    (x, y) =>
      x.from.cardinality === y.from.cardinality &&
      x.to.cardinality === y.to.cardinality,
  );
  for (const r of relations) count(counts, r.status);
  return { tables, relations, counts };
}

/** A field's settings, the way the card shows them. */
export function fieldBadges(f: Field): string[] {
  const out: string[] = [];
  if (f.pk) out.push("pk");
  if (f.fk) out.push("fk");
  if (f.unique && !f.pk) out.push("unique");
  if (f.increment) out.push("increment");
  return out;
}

/** What changed about a field, for the tooltip of a changed row. */
export function fieldChange(before: Field, after: Field): string {
  const parts: string[] = [];
  if (before.type !== after.type)
    parts.push(`type ${before.type} → ${after.type}`);
  const flag = (label: string, x: boolean, y: boolean) => {
    if (x !== y) parts.push(y ? `now ${label}` : `no longer ${label}`);
  };
  flag("primary key", before.pk, after.pk);
  flag("unique", before.unique, after.unique);
  flag("not null", before.notNull, after.notNull);
  flag("increment", before.increment, after.increment);
  if (before.default !== after.default)
    parts.push(
      `default ${before.default ?? "none"} → ${after.default ?? "none"}`,
    );
  if ((before.note ?? "") !== (after.note ?? "")) parts.push("note changed");
  return parts.join(", ");
}

export const tableName = (t: Table) =>
  `${t.name} ${t.kind === "enum" ? "enum" : "table"}`;
export const fieldName = (t: Table, f: Field) =>
  t.kind === "enum" ? `${t.name}.${f.name} value` : `${t.name}.${f.name} field`;
export const relationName = (r: Relation) => {
  // Read it from the one side to the many side.
  const [one, many] =
    r.from.cardinality === "n" && r.to.cardinality === "1"
      ? [r.to, r.from]
      : [r.from, r.to];
  return `${one.table} → ${many.table} relation`;
};
