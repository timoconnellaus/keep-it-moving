# Interviewer

Interviewer is a local CLI and browser app for adaptive, agent-driven interviews and live planning. An agent creates a durable session, adds questions over time, watches an NDJSON event stream, and changes the questionnaire as answers evolve. The browser also offers an optional ambient Gemini 3.8 Live voice conversation.

## Requirements

- Node.js 22.13 or newer
- macOS or Linux
- A Gemini API key for the optional voice button
- The [archify](https://github.com/tt-a1i/archify) skill, for diagrams

## Install and develop

```sh
npm install
npm run build
npm link
npm run setup:agents
```

`npm link` installs the development `interviewer` executable. `setup:agents` links the repository skill into the shared, Claude, Codex, and Pi skill locations and adds the `/grill-me` pointer to each agent's global context file.

For voice, store your Gemini key once, from your own terminal:

```sh
interviewer config gemini-key
```

It prompts without echoing (or reads a piped key) and writes the key to a file in the user config directory that only you can read. The daemon reads that file each time voice starts, so it works whichever agent or shell started the daemon, and needs no restart. A `GEMINI_API_KEY` set in the daemon's environment takes precedence. Remove the key with `--clear`.

The daemon starts on the first CLI command and keeps running in the background. After pulling changes and running `npm run build`, restart it so it runs the new code:

```sh
interviewer daemon restart
interviewer daemon status   # pid, version, start time, whether a Gemini key is available
```

Undo development links with:

```sh
npm run unlink:dev
npm run unlink:skill
```

The global context instruction is intentionally retained because other installed copies of Interviewer may still use it; remove that one sentence manually if desired.

## First interview

```sh
interviewer session create --title "Todo list product interview"
# Open the returned URL.

interviewer question add <session-id> \
  --type single-choice \
  --prompt "Where should sessions run?" \
  --option "Local only" \
  --option "Hosted" \
  --default "Local only" \
  --recommendation "Nothing to host or secure yet."

interviewer wait <session-id>
```

`wait` blocks until there is something worth acting on, then prints one JSON batch and exits:

- the user pauses for `--idle` milliseconds (default 15000) after answering;
- no open questions remain; or
- voice asks the agent for a clarification, which returns at once.

The batch holds every queued event, the latest answer to each question it touched (with `acceptedDefault`), any notes voice passed along, and the open-question count. The agent's own edits ride along but never end a wait early. `--timeout` (default 600000) bounds the whole wait; an empty batch means nothing happened. Run it as a background process, handle the batch, then run it again.

Two lower-level watchers remain. `attach` emits a snapshot and queued events, then streams NDJSON until cancelled. `events next <session-id> --timeout 25000` long-polls for the next event. Cancelling a watcher never stops the interview, and only one watcher may attach at a time.

Rich questions and batches can be sent as JSON:

```sh
interviewer question add <session-id> --json - <<'JSON'
{"questions":[
  {"type":"text","prompt":"What should success look like?"},
  {"type":"multiple-choice","prompt":"Which platforms at launch?","options":["iOS","Android","Web"],"default":["iOS","Web"],"recommendation":"Covers most early adopters."},
  {"type":"number","prompt":"Monthly price (USD)?","min":0,"max":50,"default":6}
]}
JSON
```

Manage an evolving interview:

```sh
interviewer question update <session-id> <question-id> --json '{"prompt":"Revised wording"}'
interviewer question reorder <session-id> <question-id> --position 0
interviewer question focus <session-id> <question-id>
interviewer question delete <session-id> <question-id>
interviewer clarification reply <session-id> <request-id> --text "Context for Gemini"
interviewer note <session-id> --text "I added a follow-up on sync" [--question <question-id>] [--speak]

interviewer session stop <session-id>
interviewer session resume <session-id>
interviewer session list --all
interviewer session delete <session-id>
```

CLI output is JSON except for the long-running NDJSON attachment stream and `--help`.

## Questionnaire behavior

Question widgets include free text, single choice, multiple choice, yes/no, and number. Every widget permits a free-text answer; the widget is input convenience rather than an answer schema. For choice questions, typed text is appended to the selection as `Option — note`. Answered and skipped questions collapse and can be reopened. Editing a question never invalidates its answer automatically.

A question's optional `default` is its recommended answer: one option (or an array for multiple-choice), `"Yes"`/`"No"`, a number, or suggested text. Choice defaults must match an option; matching is case-insensitive and stored with the option's spelling. The browser pre-selects the default, marks it, and labels the primary button "Accept default". "Accept N defaults" in the header saves the default for every open question the user has not edited. Keep `recommendation` for the reasoning; it no longer needs to restate the answer.

A check mark means the local service saved the answer. A green question border means the latest revision was written to an attached agent or returned by `events next`. A new revision removes the border until that revision is delivered.

Recommendations are sanitized Markdown, shown while a question is open. Deleted questions disappear from the browser but remain represented in the append-only event history.

## Workspace

An interview usually exists to produce a plan, so a session can carry a workspace beside the questions. There are four kinds of artifact:

- `plan`: the living plan document, in Markdown. There is one per session, and `interviewer plan` replaces its content.
- `document`: any other Markdown.
- `diagram`: an [archify](https://github.com/tt-a1i/archify) diagram (architecture, workflow, sequence, data flow, or lifecycle), or raw SVG.
- `mockup`: a self-contained HTML page.

```sh
interviewer plan <session-id> --file plan.md --show
interviewer artifact add <session-id> --file sync.architecture.json --quality showcase
interviewer artifact add <session-id> --file layout-a.html --title "Layout A" --description "Sidebar navigation" --show
interviewer artifact update <session-id> <artifact-id> --file layout-a.html
interviewer artifact show <session-id> <artifact-id>
interviewer artifact delete <session-id> <artifact-id>
```

`--kind` is inferred from `.md`, `.svg` and `.html` files, and from archify specs; `--file -` reads stdin. Each content change increments the artifact's revision. Agent-facing responses (`session show`, `wait`, `attach`, `events next`) omit artifact content and source, and report its `size`, since the agent wrote them.

Diagrams come from archify, a separate skill that turns a small typed JSON spec into an interactive HTML viewer. Pass the spec, any JSON file with a `diagram_type`, and the CLI does the rest:

1. It finds the archify skill (`~/.agents`, `~/.claude` or `~/.codex` `skills/archify`, or `INTERVIEWER_ARCHIFY`).
2. It runs `archify validate`. On failure it exits with archify's diagnostics and supported fixes.
3. It renders the HTML and uploads it along with the spec.

`--quality showcase` applies archify's stricter layout checks. HTML that `archify deliver` already produced can be added with `--kind diagram`, and plain SVG is shown as an image. Mermaid is no longer rendered; older Mermaid diagrams are shown as source.

When a session has artifacts, the page becomes two columns: a sticky stage and the questions. The stage has a tab per artifact; with nothing chosen it shows the plan. The agent (`--show`, `artifact show`), Gemini (`show_artifact`) and the user (clicking a tab) can all change what is on screen, and the stage labels who did it. "Expand" hides the questions; Esc restores them.

Plans and documents render as GitHub-flavored Markdown. SVG diagrams display as images, so script inside them never runs.

HTML artifacts (mockups and archify diagrams) load from their own URL, `/api/browser/<token>/artifacts/<id>/view`, rather than traveling in state updates; an archify diagram is about 700 KB. That response carries `Content-Security-Policy: sandbox allow-scripts` and `Referrer-Policy: no-referrer`. The document runs scripts with an opaque origin, so it can use CDN scripts and styles, but it cannot read the page, call the local API, open popups, submit forms, or leak the tokenized URL to a CDN. The frame itself carries no `sandbox` attribute: the header provides the same isolation, and some embedded browsers refuse to load sandbox-attributed frames over the network.

Beside the questions, archify diagrams use archify's compact embed mode (`?embed=1`). Expanded, they show archify's full viewer, with themes, pan and zoom, path tracing, presentation and export. Both use the light theme to match the page.

Questions can point at the workspace:

- `artifactId` puts a link on the question. Focusing the question, whether by the agent, Gemini or the page, shows that artifact.
- `optionArtifacts` maps option labels to artifacts, for choices such as "which layout?". Those options render as cards with live thumbnails and a "View" button. Renaming options drops links to labels that no longer exist.

```json
{
  "type": "single-choice",
  "prompt": "Which main layout should v1 use?",
  "options": ["Sidebar", "Board"],
  "optionArtifacts": { "Sidebar": "<artifact-id>", "Board": "<artifact-id>" },
  "default": "Sidebar"
}
```

## Gemini Live

The mic button starts and stops one ambient voice session. There is no visible transcript. The local service mints a constrained ephemeral token for `gemini-3.8-live`; the browser uses it for the low-latency Live connection. The long-lived API key remains in the daemon.

Gemini's instructions follow the Live API best-practice layout (persona, conversation rules, tool rules, guardrails). It leads with defaults: it groups two to four related open questions, gives its picks for the group in a sentence or two, and asks whether to keep them. It never reads questions aloud, since they are on screen. It can call:

- `focus_questions(question_ids)`: highlights the group under discussion, with a Gemini label on the first question.
- `accept_defaults(question_ids)`: saves each question's default, composed exactly as the page's "Accept default" would.
- `submit_answers(answers)`: saves several answers the user gave in their own words.
- `skip_questions(question_ids)`
- `note_for_interviewer(note, question_id?)`: passes on anything the user says that matters for the plan but doesn't answer an open question. It becomes a `voice.note` event and ends a `wait`.
- `request_clarification(question_id, request)`
- `show_artifact(artifact_id)`: puts a workspace item on screen.

All tools are non-blocking. Successful results return with `SILENT` scheduling, so saving an answer doesn't make Gemini speak again; failures use `WHEN_IDLE` so it can tell the user. Clarification stays pending while the agent receives `clarification.requested` and replies through the CLI. The reply is correlated to the original call and returned with `WHEN_IDLE`. Clarification traffic is absent from the visible questionnaire.

Starting the microphone sends the full questionnaire as a completed turn, so Gemini opens the conversation. After that, Gemini hears about changes through short "Questionnaire update" messages covering added, changed and removed questions, answers given on screen, and interviewer notes. Changes Gemini made itself are left out. Live client content interrupts any generation in progress, so updates wait until Gemini has finished its turn and any reply it owes the user. They are sent with `turnComplete: false`, which adds context without prompting speech. `interviewer note --speak` is the exception: once Gemini is quiet it is prompted to relay the note.

Gemini also knows the workspace. It gets the list of artifacts, the plan text (up to 6,000 characters), and what is on screen along with who put it there. Archify diagrams go as their spec with coordinates and styling stripped, and mockups as their description. When a diagram or mockup comes on screen, or its revision changes, the page takes a JPEG snapshot (at most 1024 px) and attaches it to that update, so Gemini can talk about what the user is actually looking at. The picture rides in client content alongside the text rather than on the realtime video stream, which has much shorter session limits. HTML artifacts photograph themselves: the served document includes a small html-to-image script that answers capture requests over `postMessage`.

Microphone audio is captured in an AudioWorklet at 16 kHz and sent in 40 ms chunks. If the browser refuses a 16 kHz capture context, the audio is downsampled with an averaging filter instead. Playback uses a separate context. Sessions enable sliding-window context compression.

Whole-utterance input/output transcriptions and the latest resumable handle are stored for continuity; audio is not stored. Native resumption is attempted first, while recent local transcript context supports a new connection after a handle expires. GoAway and ordinary connection closure trigger reconnection while the mic remains active.

## Architecture

```text
agent CLI ──HTTP/NDJSON──┐
                         │
                     loopback daemon ── SQLite
                         │       │
        browser UI ──HTTP/WS────┘       └─ ephemeral-token minting
             │
             └──────── Gemini Live WebSocket
```

- **Store module:** session, question, answer, event, clarification, tool-call, and voice-continuity state.
- **HTTP/WebSocket module:** loopback-only command interface, watcher lease, browser state broadcasts, and token minting.
- **CLI:** auto-starts the built daemon and presents the machine-readable interface.
- **Gemini protocol adapter:** correlates non-blocking function calls, delayed results, and cancellations.

Application data follows platform conventions through `env-paths`. On macOS the database is normally under `~/Library/Application Support/interviewer-nodejs/`; run `interviewer session list --all` rather than depending on the exact path.

The daemon binds only to `127.0.0.1:47831`. Session browser URLs use random 192-bit tokens. Browser origins are restricted to the daemon origin and the local Vite development origin.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

The default suite uses in-memory or temporary SQLite databases and deterministic Gemini protocol fakes. An opt-in real Live connection smoke test is available:

```sh
GEMINI_SMOKE=1 GEMINI_API_KEY=... npm run smoke:gemini
```

## Current limitations

- One local daemon and one watcher per session.
- Windows process lifecycle is not tested.
- Native Gemini resumability is bounded by Google's handle lifetime and resumable checkpoints; long-term continuity is an app-owned recent-text fallback, not indefinite model memory.
- A clarification tool result is hidden from the questionnaire, but once returned it is ordinary Gemini context.
- Canvas, diagrams, drawing, uploads, ranking, and rich HTML questions are future work.
- The `range` type was retired; existing range questions display as number questions.
- Snapshot images reach Gemini through client content. Google documents images there generally, but it has not been verified against `gemini-3.8-live` with a real key.
- A mockup snapshot covers at most the top 2,000 px of the page. External images inside a mockup may be missing from it.
