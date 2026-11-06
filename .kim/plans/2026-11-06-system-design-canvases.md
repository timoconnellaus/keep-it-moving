# System design canvases, backed by the repo

**Goal:** when you plan a feature technically, work through the data model, architecture and flows *in* the interview, starting from what's already in the repo and ending with updated files committed in the PR.

## What `.kim/` holds

```
.kim/
  kim.json            project settings
  design-system/      optional: tokens.css, components.html, README.md
  designs/            .dbml .d2 .mmd .yaml, each with a rendered .svg
  mockups/            HTML screens, linking the design system when there is one
  plans/              each finished interview's plan (read only later)
```

Not stored: chat transcripts and answers. Everything in `.kim/` is **available context, not required reading**: the agent decides what to use.

## Decisions

**Design types and formats**

| Type | Format | Shown as |
| --- | --- | --- |
| Data model | DBML | entity diagram |
| Architecture, data flow | D2 | diagram |
| Sequence, state machine | Mermaid | diagram |
| API contract | OpenAPI (YAML) | endpoint cards |

- Notes and decisions live **inside the file**, using the format's own notes and comments.
- kim writes a rendered **`.svg` beside each design**, so the PR shows the picture and its image diff. SVGs are rendered **on the server** with the site's renderer, and Mermaid uses Browser Rendering.

**Workspace**

- A new **System** tab holds the technical designs, listed by type on the left with the canvas on the right.
- The **design system** sits on the **Design** tab, beside the mockups. Past plans go on Document.
- **Nothing from `.kim/` is shown by default.** The agent pulls in what the conversation needs, and you can ask for more.
- **Loaded is not shown.** A mockup that uses the design system always gets it, because kim bundles the tokens. The design system appears only when a change touches it, along with the mockups that change affects.
- The canvas **compares each item with its repo version**: added, changed and removed are highlighted, and you can turn this off.
- **Editing:** you comment, and the agent edits and replies.
- For a request like "make it blue", **the agent decides** between changing the token and making a one-off override, and says which.
- The **design system is optional**. Without one, mockups carry their own styles. When you ask for one, the agent drafts it from the app's CSS.

**Repo sync**

- Interviews pull **only from the repo**, as a copy that records its path and commit.
- When the interview **stops**, kim writes to `.kim/` only the items the agent marked to keep. Badges show *Saves to repo* or *Interview only*.
- If main changed since the copy, the **agent merges** base, theirs and ours, and you review the result.
- Available to **every plan**, Free included.

## Technical approach

- A new artifact kind, `design`, has a `type`, a `source`, and an `origin` (path, base commit and base source). The comparison parses the source and the base source by type and diffs entities, fields, nodes, edges, messages, transitions and endpoints.
- Renderers live in one shared bundle that runs in the browser and the Worker: `@dbml/core` with our own entity layout, D2 compiled to WebAssembly, Mermaid, and OpenAPI drawn as cards.
- New CLI commands: `kim design pull <path>`, `kim design keep|drop <id>`, and `kim design write <session>`. `kim session stop`, run in the repo, writes the kept items and their SVGs. Mockups and design-system items use the same commands.
- Mockups link `../design-system/tokens.css`. kim inlines it on pull and add, and turns it back into a link on write. A token change re-renders every mockup that uses it.
- The skill teaches agents to look in `.kim/`, pull only what's relevant, keep or drop items, and say whether they changed a token or made an override.

## Build order

1. **System tab and design artifacts** inside an interview: the six renderers and the comparison (with a base the agent supplies).
2. **Repo sync:** `kim design pull`, keep and drop, writing on stop, the badges, and merging when main has moved.
3. **SVG previews** rendered on the server and written beside each design.
4. **Design system** on the Design tab: tokens.css bundling, token changes showing the mockups they affect, and drafting a design system from the app's CSS.
5. **Plans to `.kim/plans/`** on stop.

Each step ships on its own, and gets deployed as it lands.
