import { describe, expect, it } from "vitest";
import { SAMPLES } from "../src/design/dev/samples.js";
import {
  annotateSequence,
  diffSequence,
  messageName,
  parseSequence,
} from "../src/design/sequence.js";
import {
  annotateState,
  diffState,
  parseState,
  transitionName,
} from "../src/design/state.js";

describe("sequence diagrams", () => {
  const base = `sequenceDiagram
  participant A as Alice
  participant B as Bob
  participant C as Carol
  A->>B: hello
  B-->>A: hi
  A->>C: ping
  A->>B: bye`;
  const current = `sequenceDiagram
  participant A as Alice
  participant B as Robert
  actor D as Dave
  A->>B: hello
  B-->>A: hi there
  loop every minute
    A-)D: poll
  end
  A->>B: bye`;

  it("reads participants and messages", () => {
    const model = parseSequence(current);
    expect(
      model.participants.map((p) => `${p.kind}:${p.id}=${p.label}`),
    ).toEqual(["participant:A=Alice", "participant:B=Robert", "actor:D=Dave"]);
    expect(
      model.messages.map((m) => `${m.from}${m.arrow}${m.to}:${m.text}`),
    ).toEqual(["A->>B:hello", "B-->>A:hi there", "A-)D:poll", "A->>B:bye"]);
    expect(
      messageName(
        model.messages[0]!,
        new Map([
          ["A", "Alice"],
          ["B", "Bob"],
        ]),
      ),
    ).toBe("Alice → Bob: hello message");
  });

  it("diffs participants by id and messages in order", () => {
    const diff = diffSequence(parseSequence(base), parseSequence(current));
    expect(diff.participants.map((p) => `${p.item.id}:${p.status}`)).toEqual([
      "A:same",
      "B:changed",
      "C:removed",
      "D:added",
    ]);
    expect(diff.messages.map((m) => `${m.item.text}:${m.status}`)).toEqual([
      "hello:same",
      "hi there:changed",
      "ping:removed",
      "poll:added",
      "bye:same",
    ]);
    expect(diff.counts).toEqual({ added: 2, changed: 2, removed: 2 });
  });

  it("wraps changes in coloured rects and puts removed messages back, dotted", () => {
    const model = parseSequence(current);
    const out = annotateSequence(
      model,
      diffSequence(parseSequence(base), model),
    );
    const lines = out.source.split("\n").map((l) => l.trim());
    const at = (text: string) => lines.indexOf(text);
    expect(lines[at("B-->>A: hi there") - 1]).toBe("rect rgb(255, 241, 214)");
    expect(lines[at("A-)D: poll") - 1]).toBe("rect rgb(227, 247, 236)");
    expect(at("A-->>C: ping")).toBeGreaterThan(at("B-->>A: hi there"));
    expect(lines[at("A-->>C: ping") - 1]).toBe("rect rgb(253, 232, 232)");
    expect(lines).toContain("participant C as Carol");
    expect(lines.filter((l) => l.startsWith("rect")).length).toBe(
      lines.filter((l) => l === "end").length - 1,
    );
    expect(out.messages.map((m) => `${m.message.text}:${m.status}`)).toEqual([
      "hello:same",
      "hi there:changed",
      "ping:removed",
      "poll:added",
      "bye:same",
    ]);
  });
});

describe("state diagrams", () => {
  const sample = SAMPLES.state!;

  it("reads states, labels and transitions", () => {
    const model = parseState(sample.source);
    expect(model.states.find((s) => s.id === "Pulled")?.label).toBe(
      "Pulled from repo",
    );
    expect(model.transitions[0]).toMatchObject({
      from: "/[*]",
      to: "Pulled",
      label: "",
    });
    expect(transitionName(model.transitions[1]!, new Map())).toBe(
      "start → Drafted: agent adds transition",
    );
  });

  it("scopes starts to composite states", () => {
    const model = parseState(`stateDiagram-v2
  state Big {
    [*] --> Inner
  }
  [*] --> Big`);
    expect(model.transitions.map((t) => t.from)).toEqual(["Big/[*]", "/[*]"]);
    expect(model.states.find((s) => s.id === "Inner")?.parent).toBe("Big");
    expect(model.states.find((s) => s.id === "Big")?.composite).toBe(true);
  });

  it("diffs states and transitions", () => {
    const diff = diffState(parseState(sample.base!), parseState(sample.source));
    const states = Object.fromEntries(
      diff.states.map((s) => [s.item.id, s.status]),
    );
    expect(states).toMatchObject({
      Pulled: "changed",
      Drafted: "added",
      Merging: "added",
      Dropped: "removed",
      Kept: "same",
    });
    expect(diff.counts).toEqual({ added: 6, changed: 1, removed: 3 });
  });

  it("adds classDefs and puts removed states and transitions back", () => {
    const model = parseState(sample.source);
    const diff = diffState(parseState(sample.base!), model);
    const out = annotateState(sample.source, model, diff);
    expect(out.source.startsWith(sample.source.trimEnd())).toBe(true);
    expect(out.source).toMatch(/classDef kimAdded fill:#e3f7ec/);
    expect(out.source).toContain("class Drafted,Merging kimAdded");
    expect(out.source).toContain("class Pulled kimChanged");
    expect(out.source).toContain("class Dropped kimRemoved");
    expect(out.source).toContain("Pulled --> Dropped : kim design drop");
    expect(out.source).toContain("Dropped --> [*]");
    // One entry per edge Mermaid will draw, in source order, removed last.
    expect(out.transitions).toHaveLength(model.transitions.length + 2);
    expect(out.transitions.at(-1)?.status).toBe("removed");
    expect(out.transitions[1]).toMatchObject({
      status: "added",
      transition: { to: "Drafted" },
    });
  });
});
