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

In the browser, the interview title is a switcher (click it, or press ⌘K): every interview, grouped by project, with its branch, agent session, progress and whether it waits on you. A dot on the title counts the other interviews waiting on you, and updates live. The site root is the Keep it moving inbox (below), whose ⌘K switcher lists every interview the same way.

## Keep it moving

The site is becoming **Keep it moving** ([the spec](docs/keep-it-moving.md)): one place that shows what every project's agent sessions are doing and what needs you. The binary has a `kim` alias.

```sh
interviewer hooks install    # once per machine: Claude Code sessions report in
```

`hooks install` adds a `SessionStart`, `UserPromptSubmit`, `Notification`, `Stop` and `SessionEnd` hook to `~/.claude/settings.json` (or `--settings <path>`), next to the hooks already there; it is idempotent, and `hooks uninstall` removes only its own. Each runs `interviewer hook <event>`, which reads the hook's JSON and reports the session: running, needs you (a notification, with its message), idle (its turn ended, with the last assistant message as the brief) or done. It works out the project, branch and worktree from the session's directory, prints nothing, and always exits 0 within about 3 seconds, so it never holds Claude Code up.

Agents can also report explicitly, and raise a request and wait for the answer in one command:

```sh
interviewer report --status idle --brief "Opened PR 16; tests pass" --pr <url> --follow-up "Add rate limiting"
interviewer ask --title "Run the migration?" --brief "It's ready; prod has no backup from today" --json - <<'JSON'
{"questions":[{"type":"single-choice","prompt":"Run it now?","options":["Back up first","Run now","Stop"],"default":"Back up first"}]}
JSON
```

Both find the session from `CLAUDE_CODE_SESSION_ID` (or `--session`), and in a cloud session from `CLAUDE_CODE_REMOTE_SESSION_ID` ([Cloud sessions](#cloud-sessions)). `ask` creates an interview linked to the session, marks the session as needing you, prints the URL to stderr, then waits like `wait` and prints the batch with its `interviewId`.

In the browser, `/` is the inbox: requests with open questions and sessions waiting on you, oldest first. A request's questions are answered right there. **Done → next** and **Snooze** (an hour) hide an item in that browser. The rail on the left lists each project with what needs you and what's running; `/p/<project>` shows its sessions and their requests. Push notifications fire for each new inbox item.

## Automations and machines

A long-running loop, such as a project's `/loop /babysitter`, registers itself and checks in once per iteration:

```sh
interviewer heartbeat babysitter --every 5m --command "/loop /babysitter" --status "merged #15; 2 queued" --quiet
```

The first beat registers the automation under the current repo's project (the same key `session create` detects; `--project <key>` overrides it), and each beat records the time, this machine's hostname and an optional `--status` line. `--every` takes `30s`, `5m`, `1h`, `1d` or a number of seconds, and defaults to 5 minutes. With `--quiet` the command prints nothing and always exits 0, so a network blip never breaks the loop. Each heartbeat also counts as the machine checking in.

Once a minute the Worker's alarm marks an automation **down** when it has missed two check-ins (more than twice its interval since the last beat). A down automation shows in the inbox with its expected interval, last beat, last status and whether its machine is still alive (seen in the last 10 minutes): if the machine is alive, the loop itself stopped and needs restarting. The next beat brings it back. The project page lists each project's automations and machines; `interviewer automation list [--project <key>|--all]` and `automation remove <id>` do the same from the CLI, and the page can remove a stale one.

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

## Backlog, milestones and follow-ups

Each project shows one current milestone with its progress, an "Up next" list (the backlog in milestone order) and the follow-ups finished sessions left undone. The workbench only reads the backlog; it writes back to the source when you accept a follow-up, or on every follow-up once `backlog auto-write on` is set.

- **GitHub Issues** sync on the server with the Worker's `GITHUB_TOKEN`, and are the default for any `github.com` project: open issues plus those closed in the last 14 days, and open milestones. An assignee or an "in progress" label means in progress; labels like `P1` or `priority: high` set the priority. They sync on demand (**Sync now**, `backlog sync`, `backlog next`) and every 15 minutes in the background.
- **Any other source** uses a per-project **sync script**. The Worker stores it, `interviewer backlog sync` runs it locally with the current `node` (from the current directory, with your environment, for up to 60 seconds) and uploads what it prints on stdout. A failure is recorded on the project and its stderr shown. The script comes from the Worker, so each machine runs only scripts it approved: one saved with `backlog script set` from that machine is approved, and any other needs `backlog sync --trust` once (read it first with `backlog show`). Approvals are SHA-256 hashes in the CLI's config folder, so an edited script needs approving again.
- The **current milestone** is the one you set (`backlog milestone set <name>`), else the open one due soonest that still has open items, else the one with the most open items. A source without milestones can use one defined here: `backlog milestone add <name> --due 2026-11-30`.

A sync script prints this shape. Statuses are `todo`, `in_progress`, `done` and `cancelled`; a lower `priority` or `order` comes first, and an item's `milestone` names a milestone's `sourceId` or `name`. For example, the current Linear cycle's issues:

```js
// sync.mjs: LINEAR_API_KEY comes from the environment of whoever runs the sync.
const query = `{ viewer { teams(first: 1) { nodes { activeCycle {
  id name endsAt
  issues { nodes { identifier title url priority sortOrder
    state { type } assignee { name } labels { nodes { name } } } } } } } } }`;
const response = await fetch("https://api.linear.app/graphql", {
  method: "POST",
  headers: {
    authorization: process.env.LINEAR_API_KEY,
    "content-type": "application/json",
  },
  body: JSON.stringify({ query }),
});
if (!response.ok) throw new Error(`Linear ${response.status}`);
const cycle = (await response.json()).data.viewer.teams.nodes[0].activeCycle;
const status = {
  started: "in_progress",
  completed: "done",
  canceled: "cancelled",
};
console.log(
  JSON.stringify({
    milestones: [{ sourceId: cycle.id, name: cycle.name, due: cycle.endsAt }],
    items: cycle.issues.nodes.map((issue) => ({
      sourceId: issue.identifier,
      title: issue.title,
      status: status[issue.state.type] ?? "todo",
      url: issue.url,
      milestone: cycle.id,
      priority: issue.priority || undefined,
      order: issue.sortOrder,
      assignee: issue.assignee?.name,
      labels: issue.labels.nodes.map((label) => label.name),
    })),
  }),
);
```

```sh
interviewer backlog script set --file sync.mjs   # saves it and switches the project to it
interviewer backlog sync                          # runs it and uploads the result
interviewer backlog next --limit 5                # sync, then the top open items as JSON
interviewer backlog source github|script|none
interviewer backlog show
```

Each command uses the current repo's project; `--project <key>` picks another. Agents report follow-ups with `interviewer report --follow-up "…"`; they reach the inbox as one item per project, where **To backlog** adds them to the source (a GitHub issue, or a local item for other sources), **Start** copies a `claude "…"` command, and ✕ dismisses them.

## Agent keys (cloud sessions)

A cloud session can't run the browser sign-in, so it authenticates with an agent key instead: long-lived, revocable, one per project's cloud environment.

```sh
interviewer key create "frockbot cloud"   # prints the key once
interviewer key list                      # names, created, last used, revoked
interviewer key revoke "frockbot cloud"
```

Store the key as `INTERVIEWER_TOKEN` in the cloud environment's variables (`interviewer cloud setup`, below, does this for you). The CLI sends it instead of an OAuth token; the Worker checks its SHA-256 against the Durable Object (only the hash is stored) and lets it report and work on the agent API: sessions, requests, heartbeats, follow-ups, backlog sync and reads. Environment variables are readable by anyone using the environment, so a key can't delete interviews or automations, rename projects, change backlog settings or sync scripts, or create, list or revoke keys; a leaked one can always be cut off from a signed-in CLI. Live key names are unique, and revoking by name revokes every match.

## Cloud sessions

Claude Code sessions on claude.ai/code run in a VM that never sees this Mac's `~/.claude`, so they need the CLI, a key and a way to run its hooks. Each project's cloud environment gets three things, and `cloud setup` prints all three, ready to paste:

```sh
cd ~/repos/frockbot
interviewer cloud setup                 # or --project github.com/o/frockbot
interviewer cloud setup --json          # the same, as JSON
```

It creates an agent key named "<project name> cloud" (`--key-name` picks another). Keys can't be read back, so if a live key already has that name it stops and says so: revoke the old one (`interviewer key revoke "Frockbot cloud"`) or pass `--key-name`. It needs a signed-in CLI, not a key.

1. **Network access**: Custom, add `interviewer.zerobsai.com`, and keep the default package registries included. The default Trusted level allows GitHub and the registries but not this host.
2. **Environment variables**: `INTERVIEWER_TOKEN=kim_…`. Anyone who uses the environment can read it.
3. **Setup script**: it installs the CLI from the Worker, then installs the user-level hooks in the VM. Every line ends in `|| true`, so a failure never stops a session from starting:

   ```bash
   #!/bin/bash
   npm install -g https://interviewer.zerobsai.com/cli.tgz || true
   interviewer hooks install || true
   exit 0
   ```

The setup script's hooks are **experimental**. They write `/root/.claude/settings.json`, and Claude Code's docs say cloud sessions run hooks from the repo's committed `.claude/settings.json` but don't say whether they read the user-level file. Start a cloud session and check that it shows up in Keep it moving. If it doesn't, use the per-repo fallback, from a checkout of the repo:

```sh
interviewer hooks install --project     # writes .claude/settings.json; commits nothing
git add .claude/settings.json && git commit -m "Report cloud sessions to Keep it moving"
```

It adds the same five hooks to the repo's `.claude/settings.json`, merged beside what's there and idempotent like the user-level install, each guarded so it runs only where `INTERVIEWER_TOKEN` is set: `[ -n "$INTERVIEWER_TOKEN" ] && interviewer hook Stop || true`. Teammates without a token are unaffected, and so is your Mac, which reports through its user-level hooks and normally has no `INTERVIEWER_TOKEN`. If both copies do fire (a token set locally, or a VM that reads both files), the hook reports once: the first copy to start writes a marker named after the hook's input, and the other sees it and stays quiet. `hooks uninstall --project` removes them. Cloud hooks run only in single-repo sessions.

In a cloud session, the CLI also sends `CLAUDE_CODE_REMOTE_SESSION_ID` (`cse_…`) with each hook's report. The session then links to its page on claude.ai (**Open session** on the inbox item and the project page), and `report` and `ask`, which don't get Claude Code's session id there, find the session by that remote id. Until a hook has reported, they file it under the remote id; the hooks' first report adopts it.

The CLI package is public at `/cli.tgz`; it holds no secrets. `npm run build` packs it into `web-dist/cli.tgz` (`scripts/pack-cli.mjs`), with only its runtime dependency, `env-paths`, and fails if the CLI imports a package that isn't a dependency. The Worker serves it without the Access check, but Cloudflare Access itself sits in front of the Worker: add `/cli.tgz` to the Access bypass app, then check that `curl -fsSI https://interviewer.zerobsai.com/cli.tgz` answers 200 without a sign-in.

## On your phone

The interviewer installs as an app. On Android, open the site in Chrome, sign in, and choose **Install app** from the menu; Chrome builds a real app (a WebAPK) that shares Chrome's Access sign-in. It opens on the inbox.

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

Cloudflare Access has two apps: one for the whole host, allowing only the owner, and a bypass for `/api/sessions`, `/token`, `/register` and `/.well-known`, where OAuth applies instead, and for `/cli.tgz`, which cloud setup scripts install without a sign-in. `ACCESS_AUD` in `wrangler.jsonc` must hold the first app's audience tag.

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
