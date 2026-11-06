import { designTypes, type DesignType } from "./shared/designs.js";

/** Each design type's file extension in .kim/designs/. */
export const DESIGN_EXTENSIONS: Record<DesignType, string> = {
  "data-model": "dbml",
  architecture: "d2",
  "data-flow": "d2",
  sequence: "mmd",
  state: "mmd",
  api: "yaml",
};

const isDesignType = (value: string): value is DesignType =>
  (designTypes as readonly string[]).includes(value);

/**
 * A design's type from its file name and content, or null when it isn't
 * one. A name like `checkout.data-flow.d2` says its type outright; else
 * the extension does, and for Mermaid and YAML the content decides.
 */
export function designTypeOf(
  file: string | undefined,
  content: string,
): DesignType | null {
  const name = (file ?? "").split("/").pop()!.toLowerCase();
  const parts = name.split(".");
  const extension = parts.length > 1 ? parts.pop()! : "";
  const named = parts.length > 1 ? parts.pop()! : "";
  if (isDesignType(named)) return named;
  if (extension === "dbml") return "data-model";
  if (extension === "d2") return "architecture";
  if (extension === "mmd" || extension === "mermaid") {
    const first = content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("%%") && line !== "---");
    if (first?.startsWith("sequenceDiagram")) return "sequence";
    if (first?.startsWith("stateDiagram")) return "state";
    return null;
  }
  if (
    (extension === "yaml" || extension === "yml" || extension === "json") &&
    /^\s*["']?openapi["']?\s*:/m.test(content)
  )
    return "api";
  return null;
}

/** A design type named on the command line, checked. */
export function parseDesignType(value: string): DesignType {
  if (!isDesignType(value))
    throw new Error(
      `Unknown design type "${value}"; use one of ${designTypes.join(", ")}`,
    );
  return value;
}
