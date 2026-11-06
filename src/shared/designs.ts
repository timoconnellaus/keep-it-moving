/**
 * A system design's type, each written in the text format that suits it:
 * DBML for data models, D2 for architecture and data flow, Mermaid for
 * sequences and state machines, OpenAPI (YAML) for API contracts.
 */
export const designTypes = [
  "data-model",
  "architecture",
  "data-flow",
  "sequence",
  "state",
  "api",
] as const;
export type DesignType = (typeof designTypes)[number];
