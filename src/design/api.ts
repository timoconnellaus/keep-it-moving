import { parseDocument } from "yaml";
import { align, matchByKey, type Merged } from "./align.js";
import { DesignParseError } from "./errors.js";
import { count, noChanges, type ChangeCounts, type Status } from "./types.js";

/** An OpenAPI 3 document, reduced to one card per operation. */

export interface Section {
  /** "Request", or a response status like "200". */
  title: string;
  lines: string[];
}

export interface Operation {
  method: string;
  path: string;
  summary: string;
  deprecated: boolean;
  /** Request first, then one section per response. */
  sections: Section[];
}

export interface ApiModel {
  title: string | null;
  version: string | null;
  operations: Operation[];
}

const METHODS = [
  "get",
  "put",
  "post",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const refName = (ref: string) => ref.split("/").pop() ?? ref;

/** Follows a local `$ref` (#/components/...) once. */
function resolve(root: Obj, value: unknown): unknown {
  if (!isObj(value) || typeof value.$ref !== "string") return value;
  const ref = value.$ref;
  if (!ref.startsWith("#/")) return value;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!isObj(node)) return value;
    node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node ?? value;
}

/** A schema as a one-line type, naming `$ref`s instead of opening them. */
function typeText(root: Obj, schema: unknown, depth: number): string {
  if (!isObj(schema)) return "any";
  if (typeof schema.$ref === "string") return refName(schema.$ref);
  const nullable = schema.nullable === true ? " | null" : "";
  if (Array.isArray(schema.enum))
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ") + nullable;
  for (const [k, sep] of [
    ["oneOf", " | "],
    ["anyOf", " | "],
    ["allOf", " & "],
  ] as const)
    if (Array.isArray(schema[k]))
      return (
        (schema[k] as unknown[])
          .map((s) => typeText(root, s, depth))
          .join(sep) + nullable
      );
  let type = schema.type;
  if (Array.isArray(type)) {
    const types = type.filter((t): t is string => typeof t === "string");
    if (types.length > 1)
      return types
        .map((t) => typeText(root, { ...schema, type: t }, depth))
        .join(" | ");
    type = types[0];
  }
  if (type === "array")
    return `${wrap(typeText(root, schema.items, depth))}[]${nullable}`;
  if (type === "object" || isObj(schema.properties)) {
    if (!isObj(schema.properties)) {
      const extra = schema.additionalProperties;
      return isObj(extra)
        ? `Record<string, ${typeText(root, extra, depth)}>`
        : "object";
    }
    if (depth >= 2) return "{ … }";
    const required = new Set(
      Array.isArray(schema.required) ? schema.required : [],
    );
    const fields = Object.entries(schema.properties).map(
      ([name, s]) =>
        `${name}${required.has(name) ? "" : "?"}: ${typeText(root, s, depth + 1)}`,
    );
    return `{ ${fields.join(", ")} }${nullable}`;
  }
  const format = str(schema.format);
  return `${typeof type === "string" ? type : "any"}${format ? `<${format}>` : ""}${nullable}`;
}

const wrap = (t: string) =>
  /[ |&]/.test(t) && !t.startsWith("{") ? `(${t})` : t;

/**
 * A schema as indented lines. A top-level `$ref` is opened one level, under
 * its name; objects list one property per line with `?` for optional ones.
 */
export function schemaLines(root: Obj, schema: unknown, indent = ""): string[] {
  let name: string | null = null;
  let s = schema;
  if (isObj(s) && typeof s.$ref === "string") {
    name = refName(s.$ref);
    s = resolve(root, s);
  }
  if (isObj(s) && s.type === "array" && isObj(s.items) && !name) {
    const inner = schemaLines(root, s.items, indent);
    if (inner.length > 1) {
      inner[inner.length - 1] += "[]";
      return inner;
    }
  }
  if (!isObj(s) || !isObj(s.properties)) {
    const text = typeText(root, s, 0);
    return [
      `${indent}${name && text !== name ? `${name} = ${text}` : (name ?? text)}`,
    ];
  }
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const out = [`${indent}${name ? `${name} ` : ""}{`];
  for (const [prop, propSchema] of Object.entries(s.properties)) {
    const comment = isObj(propSchema) ? str(propSchema.description) : null;
    const line = `${indent}  ${prop}${required.has(prop) ? "" : "?"}: ${typeText(root, propSchema, 1)}`;
    out.push(comment ? `${line}  // ${comment.split("\n")[0]}` : line);
  }
  out.push(`${indent}}`);
  return out;
}

function contentSchema(
  root: Obj,
  holder: unknown,
): { type: string | null; schema: unknown } | null {
  const h = resolve(root, holder);
  if (!isObj(h) || !isObj(h.content)) return null;
  const types = Object.keys(h.content);
  const type = types.find((t) => t.includes("json")) ?? types[0];
  if (!type) return null;
  const media = h.content[type];
  return { type, schema: isObj(media) ? media.schema : undefined };
}

function operation(
  root: Obj,
  path: string,
  method: string,
  op: Obj,
  shared: unknown[],
): Operation {
  const request: string[] = [];
  const params = new Map<string, Obj>();
  for (const p of [
    ...shared,
    ...(Array.isArray(op.parameters) ? op.parameters : []),
  ]) {
    const param = resolve(root, p);
    if (isObj(param) && typeof param.name === "string")
      params.set(`${String(param.in)}:${param.name}`, param);
  }
  for (const p of params.values()) {
    const optional = p.required === true || p.in === "path" ? "" : "?";
    request.push(
      `${String(p.in ?? "query")} ${String(p.name)}${optional}: ${typeText(root, p.schema, 1)}`,
    );
  }
  const body = contentSchema(root, op.requestBody);
  if (body) {
    if (request.length) request.push("");
    if (body.type && !body.type.includes("json"))
      request.push(`(${body.type})`);
    request.push(...schemaLines(root, body.schema));
  }
  const sections: Section[] = [
    { title: "Request", lines: request.length ? request : ["—"] },
  ];
  const responses = isObj(op.responses) ? op.responses : {};
  for (const [status, response] of Object.entries(responses)) {
    const r = resolve(root, response);
    const content = contentSchema(root, r);
    const description = isObj(r) ? str(r.description) : null;
    const lines = content
      ? schemaLines(root, content.schema)
      : [description ? `— ${description.split("\n")[0]}` : "—"];
    sections.push({ title: status, lines });
  }
  const summary =
    str(op.summary) ??
    str(op.description)?.split("\n")[0] ??
    str(op.operationId) ??
    "";
  return {
    method: method.toUpperCase(),
    path,
    summary,
    deprecated: op.deprecated === true,
    sections,
  };
}

/** Parses an OpenAPI 3 YAML (or JSON) document into its operations. */
export function parseApi(source: string): ApiModel {
  const doc = parseDocument(source, { prettyErrors: true, uniqueKeys: false });
  if (doc.errors.length > 0) throw doc.errors[0];
  const root: unknown = doc.toJS({ maxAliasCount: 1000 });
  if (!isObj(root))
    throw new DesignParseError(
      "Expected an OpenAPI document (a YAML map with `paths`).",
      1,
      1,
    );
  if (!isObj(root.paths)) {
    const line = source.split("\n").findIndex((l) => /^paths\s*:/.test(l));
    throw new DesignParseError(
      root.paths === undefined
        ? "This OpenAPI document has no `paths`."
        : "`paths` should be a map of paths to operations.",
      line >= 0 ? line + 1 : 1,
      1,
    );
  }
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(root.paths)) {
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (isObj(op)) operations.push(operation(root, path, method, op, shared));
    }
  }
  const info = isObj(root.info) ? root.info : {};
  return {
    title: str(info.title),
    version: info.version === undefined ? null : String(info.version),
    operations,
  };
}

export const operationKey = (op: Operation) => `${op.method} ${op.path}`;

export interface SectionDiff {
  status: Status;
  title: string;
  lines: Merged<string>[];
}

export interface OperationDiff {
  status: Status;
  operation: Operation;
  before?: Operation;
  sections: SectionDiff[];
}

export interface ApiDiff {
  operations: OperationDiff[];
  counts: ChangeCounts;
}

const sameLines = (lines: string[], status: Status): Merged<string>[] =>
  lines.map((item) => ({ status, item }));

export function plainApi(model: ApiModel): ApiDiff {
  return {
    operations: model.operations.map((operation) => ({
      status: "same",
      operation,
      sections: operation.sections.map((s) => ({
        status: "same",
        title: s.title,
        lines: sameLines(s.lines, "same"),
      })),
    })),
    counts: noChanges(),
  };
}

/**
 * Compares operations by method and path, then each section's lines. An
 * operation counts once: added, removed, or changed when any line or its
 * summary differs.
 */
export function diffApi(base: ApiModel, current: ApiModel): ApiDiff {
  const counts = noChanges();
  const operations = matchByKey(
    base.operations,
    current.operations,
    operationKey,
    () => true,
  ).map((entry): OperationDiff => {
    const op = entry.item;
    if (entry.status !== "same") {
      count(counts, entry.status);
      return {
        status: entry.status,
        operation: op,
        sections: op.sections.map((s) => ({
          status: entry.status,
          title: s.title,
          lines: sameLines(s.lines, entry.status),
        })),
      };
    }
    const before = entry.before!;
    const sections = matchByKey(
      before.sections,
      op.sections,
      (s) => s.title,
      () => true,
    ).map((s): SectionDiff => {
      if (s.status !== "same")
        return {
          status: s.status,
          title: s.item.title,
          lines: sameLines(s.item.lines, s.status),
        };
      const lines = align(s.before!.lines, s.item.lines, (l) => l, {
        group: (l) =>
          /^\s*([\w$-]+\??)\s*:/.exec(l)?.[1]?.replace("?", "") ?? l,
      });
      return {
        status: lines.some((l) => l.status !== "same") ? "changed" : "same",
        title: s.item.title,
        lines,
      };
    });
    const changed =
      before.summary !== op.summary ||
      before.deprecated !== op.deprecated ||
      sections.some((s) => s.status !== "same");
    if (changed) counts.changed += 1;
    return {
      status: changed ? "changed" : "same",
      operation: op,
      before,
      sections,
    };
  });
  return { operations, counts };
}

export const operationName = (op: Operation) => `${op.method} ${op.path}`;
