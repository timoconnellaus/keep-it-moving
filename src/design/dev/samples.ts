import type { DesignShell } from "../types.js";

/**
 * Sample designs for looking at the viewer by hand (write-samples.ts) and for
 * the tests: this repo's own schema, architecture and flows, each with a base
 * that differs in a few places.
 */

const dataModelBase = `// The interview hub's SQLite schema (src/server/store.ts).
Table sessions {
  id text [pk]
  title text [not null, default: 'Untitled interview']
  token text [unique, not null]
  status text [not null, default: 'active']
  focused_question_id text
  stage_artifact_id text
  created_at text [not null]
  updated_at text [not null]
  Note: 'One interview'
}

Table questions {
  id text [pk]
  session_id text [not null, ref: > sessions.id]
  type text [not null]
  prompt text [not null]
  recommendation text
  artifact_id text
  position integer [not null]
  deleted integer [not null, default: 0]
}

Table answers {
  question_id text [pk, ref: - questions.id]
  text text [not null]
  skipped integer [not null, default: 0]
  revision integer [not null]
  updated_at text [not null]
}

Table events {
  id integer [pk, increment]
  session_id text [not null, ref: > sessions.id]
  type text [not null]
  payload text [not null]
  delivered integer [not null, default: 0]
}

Table artifacts {
  id text [pk]
  session_id text [not null, ref: > sessions.id]
  kind text [not null, note: 'html, plan, document, diagram']
  title text [not null]
  content text [not null]
  revision integer [not null, default: 1]
}

Table chat_messages {
  id text [pk]
  session_id text [not null, ref: > sessions.id]
  author text [not null]
  text text [not null]
  created_at text [not null]
}

Table frame_positions {
  session_id text [ref: > sessions.id]
  artifact_id text [ref: > artifacts.id]
  x real [not null]
  y real [not null]
  indexes {
    (session_id, artifact_id) [pk]
  }
}

Table push_subscriptions {
  endpoint text [pk]
  created_at text [not null]
}
`;

const dataModel = `// The interview hub's SQLite schema (src/server/store.ts).
Table sessions {
  id text [pk]
  title text [not null, default: 'Untitled interview']
  token text [unique, not null]
  status session_status [not null, default: 'active']
  focused_question_id text
  stage_artifact_id text
  created_at text [not null]
  updated_at text [not null]
  Note: 'One interview, with its questions, artifacts and chat'
}

Enum session_status {
  active
  stopped
  archived
}

Table questions {
  id text [pk]
  session_id text [not null, ref: > sessions.id]
  type text [not null]
  prompt text [not null]
  recommendation text
  position integer [not null]
  deleted integer [not null, default: 0]
}

Table answers {
  question_id text [pk, ref: - questions.id]
  text text [not null]
  skipped integer [not null, default: 0]
  revision integer [not null]
  updated_at text [not null]
}

Table events {
  id integer [pk, increment]
  session_id text [not null, ref: > sessions.id]
  type text [not null]
  payload text [not null]
  delivered integer [not null, default: 0]
}

Table artifacts {
  id text [pk]
  session_id text [not null, ref: > sessions.id]
  kind text [not null, note: 'html, plan, document, diagram, design']
  title text [not null]
  content text [not null]
  revision integer [not null, default: 1]
}

Table designs {
  artifact_id text [pk, ref: - artifacts.id]
  type text [not null, note: 'data-model, architecture, data-flow, sequence, state, api']
  path text [note: 'Where it lives in the repo, under .kim/designs']
  base_commit text
  base_source text
  keep integer [not null, default: 0]
}

Table chat_messages {
  id text [pk]
  session_id text [not null, ref: > sessions.id]
  author text [not null]
  text text [not null]
  reply_to text [ref: > chat_messages.id]
  created_at text [not null]
}

Table frame_positions {
  session_id text [ref: > sessions.id]
  artifact_id text [ref: > artifacts.id]
  x real [not null]
  y real [not null]
  indexes {
    (session_id, artifact_id) [pk]
  }
}
`;

const architectureBase = `direction: right

agent: Coding agent {shape: person}
cli: kim CLI
browser: Browser {
  workspace: Workspace
  frames: Artifact frames
}
worker: Cloudflare Worker {
  router: Hono router
  auth: Google sign-in
  hub: Interview hub {shape: hexagon}
  sql: SQLite {shape: cylinder}
  hub -> sql: reads and writes
}
render: Browser Rendering {shape: cloud}

agent -> cli: runs
cli -> worker.router: HTTPS + WebSocket
browser.workspace -> worker.router: live socket
worker.router -> worker.auth
worker.router -> worker.hub
worker.hub -> render: screenshots
`;

const architecture = `direction: right

agent: Coding agent {shape: person}
cli: kim CLI
repo: Repo .kim folder {shape: page}
browser: Browser {
  workspace: Workspace
  frames: Artifact frames
  viewer: Design viewer
}
worker: Cloudflare Worker {
  router: Hono router
  auth: Google sign-in
  hub: Interview hub {shape: hexagon}
  sql: SQLite {shape: cylinder}
  hub -> sql: reads and writes
}

agent -> cli: runs
cli -> repo: pull and write designs
cli -> worker.router: HTTPS + WebSocket
browser.workspace -> worker.router: live socket
browser.viewer -> worker.router: /design-viewer
worker.router -> worker.auth: checks
worker.router -> worker.hub
`;

const sequenceBase = `sequenceDiagram
  participant A as Agent
  participant K as kim CLI
  participant H as Interview hub
  actor P as Person
  A->>K: kim design pull .kim/designs/schema.dbml
  K->>H: POST /api/sessions/:id/designs
  H->>H: validate source
  H-->>K: 201 design
  H-)P: shows the design
  P->>H: comments on a table
  H-->>A: comment event
`;

const sequence = `sequenceDiagram
  participant A as Agent
  participant K as kim CLI
  participant G as Git
  participant H as Interview hub
  actor P as Person
  A->>K: kim design pull .kim/designs/schema.dbml
  K->>G: read file and base commit
  K->>H: POST /api/sessions/:id/designs
  H-->>K: 201 design with base
  H-)P: shows the design, compared with the repo
  loop until the person is happy
    P->>H: comments on a table
    H-->>A: comment event
    A->>K: kim design update
  end
`;

const stateBase = `stateDiagram-v2
  [*] --> Pulled
  Pulled --> Edited : agent edits
  Edited --> Edited : agent edits
  Edited --> Kept : kim design keep
  Kept --> Written : session stops
  Pulled --> Dropped : kim design drop
  Written --> [*]
  Dropped --> [*]
`;

const state = `stateDiagram-v2
  state "Pulled from repo" as Pulled
  [*] --> Pulled
  [*] --> Drafted : agent adds
  Pulled --> Edited : agent edits
  Drafted --> Edited : agent edits
  Edited --> Edited : agent edits
  Edited --> Kept : kim design keep
  Kept --> Merging : main moved
  Merging --> Written : person approves
  Kept --> Written : session stops
  Written --> [*]
`;

const apiBase = `openapi: 3.1.0
info:
  title: Designs API
  version: "1"
paths:
  /api/sessions/{id}/designs:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    get:
      summary: Designs in this interview
      responses:
        "200":
          description: The designs
          content:
            application/json:
              schema:
                type: object
                required: [designs]
                properties:
                  designs: { type: array, items: { $ref: "#/components/schemas/Design" } }
  /api/sessions/{id}/designs/{designId}:
    patch:
      summary: Agent edits a design
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [source]
              properties:
                source: { type: string }
      responses:
        "200":
          description: Updated
          content:
            application/json:
              schema:
                type: object
                properties:
                  design: { $ref: "#/components/schemas/Design" }
                  diff: { type: string }
    delete:
      summary: Drop a design
      responses:
        "204": { description: Dropped }
components:
  schemas:
    Design:
      type: object
      required: [id, type, source]
      properties:
        id: { type: string }
        type: { $ref: "#/components/schemas/DesignType" }
        source: { type: string }
    DesignType:
      type: string
      enum: [data-model, architecture, data-flow, sequence, state, api]
`;

const api = `openapi: 3.1.0
info:
  title: Designs API
  version: "1"
paths:
  /api/sessions/{id}/designs:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    get:
      summary: Designs in this interview
      responses:
        "200":
          description: The designs
          content:
            application/json:
              schema:
                type: object
                required: [designs]
                properties:
                  designs: { type: array, items: { $ref: "#/components/schemas/Design" } }
    post:
      summary: Pull a copy from the repo
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [path, baseCommit, type, source]
              properties:
                path: { type: string, description: ".kim/designs/…" }
                baseCommit: { type: string }
                type: { $ref: "#/components/schemas/DesignType" }
                source: { type: string }
      responses:
        "201":
          description: Pulled
          content:
            application/json:
              schema:
                type: object
                properties:
                  design: { $ref: "#/components/schemas/Design" }
        "409":
          description: Already pulled
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: string, enum: [already_pulled] }
  /api/sessions/{id}/designs/{designId}:
    patch:
      summary: Agent edits a design
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [source]
              properties:
                source: { type: string }
                note: { type: string, description: why it changed }
      responses:
        "200":
          description: Updated
          content:
            application/json:
              schema:
                type: object
                properties:
                  design: { $ref: "#/components/schemas/Design" }
                  changes: { type: array, items: { $ref: "#/components/schemas/Change" } }
components:
  schemas:
    Design:
      type: object
      required: [id, type, source]
      properties:
        id: { type: string }
        type: { $ref: "#/components/schemas/DesignType" }
        source: { type: string }
        base: { type: [string, "null"] }
    DesignType:
      type: string
      enum: [data-model, architecture, data-flow, sequence, state, api]
    Change:
      type: object
      properties:
        kind: { type: string, enum: [added, changed, removed] }
        name: { type: string }
`;

export const SAMPLES: Record<string, DesignShell> = {
  "data-model": {
    type: "data-model",
    title: "Interviews schema",
    source: dataModel,
    base: dataModelBase,
  },
  architecture: {
    type: "architecture",
    title: "Worker and hubs",
    source: architecture,
    base: architectureBase,
  },
  sequence: {
    type: "sequence",
    title: "Pull a design",
    source: sequence,
    base: sequenceBase,
  },
  state: {
    type: "state",
    title: "Design lifecycle",
    source: state,
    base: stateBase,
  },
  api: { type: "api", title: "Designs API", source: api, base: apiBase },
  "data-model-plain": {
    type: "data-model",
    title: "Interviews schema",
    source: dataModel,
    base: null,
  },
  "data-model-error": {
    type: "data-model",
    title: "Broken schema",
    source: "Table users {\n  id text [pk\n  email text\n}\n",
    base: null,
  },
  "architecture-error": {
    type: "architecture",
    title: "Broken",
    source: "a -> {\n  b\n",
    base: null,
  },
  "sequence-error": {
    type: "sequence",
    title: "Broken",
    source: "sequenceDiagram\n  A->>B: hi\n  loop\n  B->>: x\n",
    base: null,
  },
  "api-error": {
    type: "api",
    title: "Broken",
    source: "openapi: 3.1.0\npaths:\n  /x:\n    get: [\n",
    base: null,
  },
};
