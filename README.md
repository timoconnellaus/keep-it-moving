# Interviewer

Interviewer is a CLI and browser app for adaptive, agent-driven interviews and live planning, hosted on a Cloudflare Worker at https://interviewer.zerobsai.com. An agent creates a durable session, adds questions over time, watches an event stream, and changes the questionnaire as answers evolve.

## Requirements

- Node.js 22.13 or newer, for the CLI
- The [archify](https://github.com/tt-a1i/archify) skill, for diagrams
- To deploy: the Cloudflare account that owns `zerobsai.com`

## Install and develop

```sh
npm install
npm run link:dev        # builds the CLI and links the `interviewer` executable
npm run setup:agents    # links the skill and adds the /grill-me pointer
interviewer login       # browser sign-in: Cloudflare Access, then OAuth back to the CLI
```

`login` stores a refresh token in the user config directory (readable only by you), keyed by service URL. `interviewer whoami` checks it and `interviewer logout` forgets it. Set `INTERVIEWER_URL` to point the CLI at another deployment, such as `wrangler dev` on `http://localhost:8787`.

Deploy with `npm run deploy`, which builds the web client and runs `wrangler deploy`.

For local development, put `DEV_EMAIL=<the allowed email>` and `PUBLIC_URL=http://localhost` in `.dev.vars` and run `npx wrangler dev --local --host localhost` (`.claude/launch.json` has it as `worker`). `--host localhost` keeps requests on localhost, where `DEV_EMAIL` stands in for the Access login.

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

- the user pauses for `--idle` milliseconds (default 15000) after answering; or
- no open questions remain.

The batch holds every queued event, the latest answer to each question it touched (with `acceptedDefault`), the open-question count, and whether the workspace is open. The agent's own edits ride along but never end a wait early. `--timeout` (default 600000) bounds the whole wait; an empty batch means nothing happened. Run it as a background process, handle the batch, then run it again.

Two lower-level watchers remain. `attach` emits a snapshot and queued events, then streams NDJSON until cancelled. `events next <session-id> --timeout 25000` long-polls for the next event. Cancelling a watcher never stops the interview. One watcher holds a session at a time, and the newest wins: a new `wait`, `attach` or `events next` takes over, the old one ends (`wait` and `events next` fail with "Replaced by a newer watcher", `attach` emits a `replaced` line and closes), and anything still queued goes to the new one. So a killed watcher never blocks the next.

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

interviewer session stop <session-id>
interviewer session resume <session-id>
interviewer session list --all
interviewer session delete <session-id>
```

CLI output is JSON except for the long-running NDJSON attachment stream and `--help`.

## Projects and switching interviews

Interviews from every agent session (local or cloud, Claude Code or Codex) are grouped by project. `session create` detects where it runs:

- **Project**: the `origin` remote, normalised to `host/owner/repo`, so SSH, HTTPS and a cloud sandbox's proxied remote all match. Without a remote it is `local/<main checkout folder>`. `--project <name>` picks an existing project by name instead.
- **Branch and worktree** from git, the **agent** from the `AI_AGENT` convention (or `--agent`), and `--agent-session "<title>"` for the session's name. `--location cloud|local` overrides where it says it runs.

The first interview from a remote creates its project, named from the repo and given the next free colour, which then stays the same everywhere. `interviewer project list`, `project rename <project> --name <name>` and `project color <project> --color <#hex>` manage them.

In the browser, the interview title is a switcher (click it, or press ⌘K): every interview, grouped by project, with its branch, agent session, progress and whether it waits on you. A dot on the title counts the other interviews waiting on you, and updates live. The site root lists every interview the same way.

## Pull requests and CI

For projects keyed by a `github.com/owner/repo` remote, the Worker reads open PRs from GitHub: checks, reviews, mergeability and diffs. It needs a token, set as a Worker secret:

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) for the repos you want, with **read-only** access to Contents, Pull requests, Checks (where offered; otherwise Commit statuses), Actions, Issues and Metadata.
2. Run `npx wrangler secret put GITHUB_TOKEN` and paste it. For `wrangler dev`, put `GITHUB_TOKEN=…` in `.dev.vars`.

Without the token, the PR routes answer 503 `{"error":"GITHUB_TOKEN not set"}` and the page shows these steps.

The Durable Object's once-a-minute alarm syncs each GitHub project at most every 2 minutes, within about 40 GitHub requests a tick. A PR whose head and update time haven't moved is only refetched every 15 minutes, unless its checks are running or failing; the timer backs off when the rate limit runs low. **Sync** on the project page syncs one project at once.

- A PR's **CI** is red when any check failed (failure, timed out, cancelled, action required), pending while any runs, green when all passed, none without checks.
- A PR is **ready** on GitHub's verdict: not a draft, no check failing or running, no reviewer's latest review requesting changes, and `mergeable_state` `clean` (or `has_hooks`). While GitHub is still computing it (`unknown`), green checks and a mergeable PR count as ready.
- The inbox gets one **CI failed** item per red PR, dated from when it went red, and one **PRs ready** item per project, dated from its oldest ready PR.
- The PR page (`/p/<project>/pr/<number>`) fetches live detail, cached for a minute: checks with log excerpts from failing Actions jobs, reviews, and the diff with a file tree.

```sh
interviewer pr list                       # this repo's open PRs (from the git remote)
interviewer pr list --project github.com/owner/repo
```

## On your phone

The interviewer installs as an app. On Android, open the site in Chrome, sign in, and choose **Install app** from the menu; Chrome builds a real app (a WebAPK) that shares Chrome's Access sign-in. It opens on the list of interviews.

**Notify me** on that page turns on push notifications for the device. When an interview with nothing open gains questions, the Worker pushes to every subscribed device, and the notification names the interview (for example "FrockBot · Checkout flow, 3 questions waiting") and opens it when tapped. **Send a test** checks the setup.

Pushes carry no data: the Worker signs an empty Web Push with its VAPID key (`VAPID_PUBLIC_KEY` in `wrangler.jsonc`, the private key in the `VAPID_PRIVATE_JWK` secret), and the service worker asks the server what is waiting. The icons, manifest and service worker are public, outside Cloudflare Access, because Google's servers fetch the icons without a sign-in when they build the app.

## Questionnaire behavior

Question widgets include free text, single choice, multiple choice, yes/no, and number. Every widget permits a free-text answer; the widget is input convenience rather than an answer schema. For choice questions, typed text is appended to the selection as `Option — note`. Answered and skipped questions collapse and can be reopened. Editing a question never invalidates its answer automatically.

A question's optional `default` is its recommended answer: one option (or an array for multiple-choice), `"Yes"`/`"No"`, a number, or suggested text. Choice defaults must match an option; matching is case-insensitive and stored with the option's spelling. The browser pre-selects the default, marks it, and labels the primary button "Accept default". "Accept N defaults" in the header saves the default for every open question the user has not edited. Keep `recommendation` for the reasoning; it no longer needs to restate the answer.

A check mark means the service saved the answer. A green question border means the latest revision was written to an attached agent or returned by `events next`. A new revision removes the border until that revision is delivered.

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

The workspace column starts closed, because the plan may be followed elsewhere, such as a Markdown file or a design open beside the interviewer. The agent opens or closes it (`interviewer stage open|close`, or `session create --open-stage`) and the user can toggle it from the header or close it from its own bar. When open, the page has two columns: a sticky stage and the questions. The stage has a tab per artifact; with nothing chosen it shows the plan. The agent (`--show`, `artifact show`) and the user (clicking a tab) can both change what is on screen, and the stage labels who did it. "Expand" hides the questions; Esc restores them.

Plans and documents render as GitHub-flavored Markdown. SVG diagrams display as images, so script inside them never runs.

HTML artifacts (mockups and archify diagrams) load from their own URL, `/api/browser/<token>/artifacts/<id>/view`, rather than traveling in state updates; an archify diagram is about 700 KB. That response carries `Content-Security-Policy: sandbox allow-scripts` and `Referrer-Policy: no-referrer`. The document runs scripts with an opaque origin, so it can use CDN scripts and styles, but it cannot read the page, call the API, open popups, submit forms, or leak the tokenized URL to a CDN. The frame itself carries no `sandbox` attribute: the header provides the same isolation, and some embedded browsers refuse to load sandbox-attributed frames over the network.

Beside the questions, archify diagrams use archify's compact embed mode (`?embed=1`). Expanded, they show archify's full viewer, with themes, pan and zoom, path tracing, presentation and export. Both use the light theme to match the page.

Questions can point at the workspace:

- `artifactId` puts a link on the question. Focusing the question, shows that artifact.
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

## Architecture

```text
agent CLI ──HTTPS + OAuth bearer──┐
                                  │
browser ──HTTPS/WSS (Access)── Worker ── InterviewHub Durable Object (SQLite)
```

- **Worker** (`src/worker`): wraps everything in `@cloudflare/workers-oauth-provider`. `/api/sessions/**` needs an OAuth access token whose account is `ALLOWED_EMAIL`. Every other route sits behind Cloudflare Access, and the Worker also verifies the Access JWT and email itself, so a misconfigured policy fails closed. `/authorize` completes OAuth straight from the Access identity, and only for loopback redirect URIs, so only the CLI can collect a code.
- **InterviewHub** (`src/worker/hub.ts`): one SQLite Durable Object holding every session. The deployment has a single user. Browser WebSockets hibernate, tagged by session.
- **Hub router and store** (`src/server`): the HTTP API (Hono) and the store, written against a small SQL interface so tests run them on `node:sqlite`.
- **CLI** (`src/cli.ts`): a thin client. `wait` chains 60 s requests with `partial=1` to stay under Cloudflare's 100 s idle cutoff; `attach` filters out the heartbeat lines that keep its stream alive.

Cloudflare Access has two apps: one for the whole host, allowing only the owner, and a bypass for `/api/sessions`, `/token`, `/register` and `/.well-known`, where OAuth applies instead. `ACCESS_AUD` in `wrangler.jsonc` must hold the first app's audience tag.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

The suite runs the hub and store on in-memory `node:sqlite`, and the CLI against them over real HTTP.

## Current limitations

- One user per deployment, and one watcher per session (the newest takes over).
- Canvas, drawing, uploads, ranking, and rich HTML questions are future work.
