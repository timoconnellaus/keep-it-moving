# Keep it moving

Keep it moving (formerly Interviewer) runs interviews between agents and people: an agent asks questions in the browser, beside a living plan, diagrams and mockups, and waits for the answers; the person answers, chats with the agent, or hands the interview to someone else. The home page lists every interview and what's left to do on it. It's hosted on a Cloudflare Worker at https://keep-it-moving.zerobsai.com. The CLI is `kim`; `interviewer` is the same command, kept so older scripts still work.

## Use it

You need Node.js 22.13 or newer and a Google account.

```sh
npm install -g https://keep-it-moving.zerobsai.com/cli.tgz
kim skill install
kim login
```

`skill install` asks which agents get the interviewer skill (Claude Code, Codex, Pi). Then ask Claude to interview you about something, such as "interview me about this feature", and answer in the browser. Diagrams also need the [archify](https://github.com/tt-a1i/archify) skill.

The skill lives in `~/.agents/skills/interviewer`, a copy kim made (marked by `.installed-by-kim`), and each chosen agent's skills folder links to it. Every `kim` run refreshes that copy when the CLI's bundled skill has changed, so the agents stay current. Outside a terminal, pick agents with `--agents claude,codex,pi` or `--all`; without either it uses the last choice, or Claude Code. It never replaces a link or folder it didn't make, such as a dev checkout's links, unless `--force`. `kim skill uninstall` removes what it made.

`kim update` reinstalls the CLI from the site and refreshes the skill. Once a day, `kim` checks the site's `/cli-version.json` (the build `npm run pack:cli` stamped into the package, a static file) and says on stderr when a newer one is out.

The code is at https://github.com/timoconnellaus/keep-it-moving. Sign in at https://keep-it-moving.zerobsai.com and use it as is, or deploy your own copy.

## Deploy your own

You need a Cloudflare account with a domain on it, and a Google Cloud project for the sign-in.

1. In `wrangler.jsonc`, set `account_id` to yours, `routes` to your domain, and `PUBLIC_URL` to its origin. Create a KV namespace (`npx wrangler kv namespace create OAUTH_KV`) and put its id in `kv_namespaces`.
2. Create the Google OAuth client and set its secrets, as in [Sign-in and secrets](#sign-in-and-secrets). Leave `OWNER_EMAIL` out.
3. For phone notifications, generate a VAPID key pair: put the public key in `VAPID_PUBLIC_KEY` and the private JWK in the `VAPID_PRIVATE_JWK` secret. Without them, notifications are off.
4. `npm install && npm run deploy`.

Your deployment serves its own CLI at `<your origin>/cli.tgz`. The CLI talks to keep-it-moving.zerobsai.com unless told otherwise, so set `KEEP_IT_MOVING_URL=<your origin>` in your shell profile before `kim login`.

## Develop

```sh
npm install
npm run link:dev        # builds the CLI and links the `interviewer` executable
npm run setup:agents    # links the skill to this checkout and adds the /grill-me pointer
kim login       # browser sign-in: Google, then OAuth back to the CLI
```

`login` stores a refresh token in the user config directory (readable only by you), keyed by service URL. `kim whoami` checks it and `kim logout` forgets it. Set `KEEP_IT_MOVING_URL` to point the CLI at another deployment, such as `wrangler dev` on `http://localhost:8787`.

Deploy with `npm run deploy`, which builds the web client and runs `wrangler deploy`.

For local development, put `DEV_EMAIL=<your email>` and `PUBLIC_URL=http://localhost` in `.dev.vars` and run `npx wrangler dev --local --host localhost` (`.claude/launch.json` has it as `worker`). `--host localhost` keeps requests on localhost, where `DEV_EMAIL` stands in for Google sign-in. To try the real sign-in locally instead, leave `DEV_EMAIL` out, put `GOOGLE_CLIENT_SECRET` in `.dev.vars`, and add `http://localhost:8787/auth/google/callback` to the OAuth client's redirect URIs.

### Sign-in and secrets

The browser signs in with Google; anyone with a Google account can, and each user gets a private workspace of their own. The Worker runs the sign-in itself (OpenID Connect with PKCE, checking Google's ID token and its verified email), so it needs a Google OAuth client:

1. In Google Cloud Console, create an OAuth client of type **Web application** with the redirect URI `https://keep-it-moving.zerobsai.com/auth/google/callback` (that is, `PUBLIC_URL` + `/auth/google/callback`).
2. Run `npx wrangler secret put GOOGLE_CLIENT_ID` and paste its client ID.
3. Run `npx wrangler secret put GOOGLE_CLIENT_SECRET` and paste its secret.

The optional `OWNER_EMAIL` secret (`npx wrangler secret put OWNER_EMAIL`) names the deployment's owner: their workspace is the one from before there were other users. Leave it out on a new deployment. These stay out of `wrangler.jsonc` so a copy of the repo doesn't deploy with someone else's.

### Assigning an interview to someone else

An interview can be assigned to someone else's email, for them to answer: `kim session create … --assign <email>`, `kim session assign <session> <email>` (or `--clear`), or **Assign** on the interview page. Send them the interview's link yourself; nothing is emailed. They sign in with Google as that email and see only that interview (its questions, the workspace items on stage, and the chat) under "From <you>"; any other account gets a page naming the masked address it was shared with and a **Switch account** link. Their answers and messages carry their email (`answeredBy` and `from` in `wait` batches, "by …" on the page), wake the waiting agent as yours do, and push to your devices once per burst. While it's assigned, its open questions wait on them, not you: the home page and the switcher say "Waiting on …". Their own home page lists it under **Shared with you**, from you.

The interview stays in the owner's workspace. The Worker keeps a directory in `OAUTH_KV` (`share:<token>` → owner and assignee, `assigned:<email>:<token>` for the list) to route the assignee there, marked with a header only the Worker sets; the owner's hub then allows that header on the one interview's page routes only, and only while the interview is still assigned to that email, so clearing the assignment locks them out at once, before KV catches up. Deleting the interview removes the entries.

## Desktop app

`desktop/` is a [Tauri](https://tauri.app) shell around the hosted site, for macOS. It needs Rust (`rustup`) and Xcode's command-line tools.

```sh
npm run desktop:dev     # run it
npm run desktop:build   # desktop/src-tauri/target/release/bundle/macos/Keep it moving.app and a .dmg
```

The window loads `KEEP_IT_MOVING_URL` (default https://keep-it-moving.zerobsai.com) and signs in with Google once; the webview keeps the cookie. Web push doesn't reach a webview, so a script injected into the site (`desktop/src-tauri/src/desktop.js`) polls the interview list every 30 seconds instead: the dock badge counts the interviews waiting on you, and each one that starts waiting raises a native notification while the window isn't focused. Links to other sites open in the default browser, the site's own links that ask for a new tab open in a new window, and ⌘R reloads. The window remembers its size and position.

The main window only loads the site and Google's sign-in (`accounts.google.com`); any other page opens in the default browser. Only the hosted origins get the native bridge (notifications, badge, opening links and windows), set in `desktop/src-tauri/capabilities/default.json`. Debug builds add `http://localhost:8787` for `wrangler dev`, so point a dev build there rather than a release build. Google may refuse to sign in inside an embedded webview; if it does, the sign-in has to move to the default browser.

## First interview

```sh
kim session create --title "Todo list product interview"
# Open the returned URL.

kim question add <session-id> \
  --type single-choice \
  --prompt "Where should sessions run?" \
  --option "Local only" \
  --option "Hosted" \
  --default "Local only" \
  --recommendation "Nothing to host or secure yet."

kim wait <session-id>
```

`wait` blocks until there is something worth acting on, then prints one JSON batch and exits:

- the user pauses for `--idle` milliseconds (default 15000) after answering;
- no open questions remain; or
- the user writes in the chat, which ends it after a short settle.

The batch holds every queued event, the latest answer to each question it touched (with `acceptedDefault`), the open-question count, and whether the workspace is open. The agent's own edits ride along but never end a wait early. `--timeout` (default 600000) bounds the whole wait; an empty batch means nothing happened. Run it as a background process, handle the batch, then run it again.

The interview page has one chat thread with the agent. The user asks about the interview, or about one question with its "Ask about this" action, or gives a direction. Their messages arrive in the batch's `messages`, each with `about` (the question's id, number and prompt) when it is about a question, and are marked delivered the way answers are. The agent answers in Markdown:

```sh
kim chat reply <session-id> --text "Sync means…" --to <message-id>
kim chat list <session-id>
```

The page shows whether an agent is watching, so a message sent while none is says it will be read at the next check-in. A message from the user puts the interview on the agent ("Waiting on the agent" on the home page) and never notifies the user; the agent's replies notify like new questions do.

Two lower-level watchers remain. `attach` emits a snapshot and queued events, then streams NDJSON until cancelled. `events next <session-id> --timeout 25000` long-polls for the next event. Cancelling a watcher never stops the interview. One watcher holds a session at a time, and the newest wins: a new `wait`, `attach` or `events next` takes over, the old one ends (`wait` and `events next` fail with "Replaced by a newer watcher", `attach` emits a `replaced` line and closes), and anything still queued goes to the new one. So a killed watcher never blocks the next.

Rich questions and batches can be sent as JSON:

```sh
kim question add <session-id> --json - <<'JSON'
{"questions":[
  {"type":"text","prompt":"What should success look like?"},
  {"type":"multiple-choice","prompt":"Which platforms at launch?","options":["iOS","Android","Web"],"default":["iOS","Web"],"recommendation":"Covers most early adopters."},
  {"type":"number","prompt":"Monthly price (USD)?","min":0,"max":50,"default":6}
]}
JSON
```

Manage an evolving interview:

```sh
kim question update <session-id> <question-id> --json '{"prompt":"Revised wording"}'
kim question reorder <session-id> <question-id> --position 0
kim question focus <session-id> <question-id>
kim question delete <session-id> <question-id>

kim session stop <session-id>
kim session resume <session-id>
kim session list --all
kim session delete <session-id> [<session-id>...]
kim session delete --stopped      # every stopped interview
```

`session delete` prints `{"deleted": [{id, title, assignee}]}`; an id that fails is listed under `failed`, the rest still go, and the command exits 1. Deleting an assigned interview also removes it from its assignee's **Shared with you**.

A quick question can skip the steps: `kim ask --title "Run the migration?" --prompt "Back up first?" --type yes-no` (or `--json` with questions) creates the interview, adds the questions, prints the URL to stderr, then waits like `wait` and prints the batch with its `interviewId`.

CLI output is JSON except for the long-running NDJSON attachment stream and `--help`.

## Home page, projects and switching interviews

The site root (`/`) lists every interview and what's left to do on it: its title and project, "N of M answered" with a bar, who it is waiting on, whom it's assigned to, and its last activity. Who it waits on:

- **you**, while it has open questions and isn't assigned;
- **the assignee**, while an assigned interview has open questions;
- **the agent**, once nothing is open, or whenever the latest chat message is yours (or the assignee's) and the agent hasn't replied.

Interviews waiting on you come first, then the other active ones, then stopped ones, newest activity first within each. Interviews other people assigned to you are listed above, under **Shared with you**. The list updates live.

Each interview carries its project as a label. `session create` detects where it runs:

- **Project**: the `origin` remote, normalised to `host/owner/repo`, so SSH, HTTPS and a cloud sandbox's proxied remote all match. Without a remote it is `local/<main checkout folder>`. `--project <name>` picks an existing project by name instead.
- **Branch and worktree** from git, the **agent** from the `AI_AGENT` convention (or `--agent`), and `--agent-session "<title>"` for the session's name. `--location cloud|local` overrides where it says it runs.

The first interview from a remote creates its project, named from the repo and given the next free colour, which then stays the same everywhere. `kim project list` lists them.

On an interview's page, the title is a switcher (click it, or press ⌘K): every interview, grouped by project, with its branch, agent session, progress and who it waits on. A dot on the title counts the other interviews waiting on you, and updates live.

## Agent keys (cloud sessions)

A cloud session can't run the browser sign-in, so it authenticates with an agent key instead: long-lived, revocable, one per project's cloud environment.

```sh
kim key create "frockbot cloud"   # prints the key once
kim key list                      # names, created, last used, revoked
kim key revoke "frockbot cloud"
```

Store the key as `KEEP_IT_MOVING_TOKEN` in the cloud environment's variables (`kim cloud setup`, below, does this for you). The CLI sends it instead of an OAuth token; the Worker checks its SHA-256 against the Durable Object (only the hash is stored) and lets it work on the agent API: create and edit interviews, wait on them, reply in their chat and assign them. Environment variables are readable by anyone using the environment, so a key can't answer questions, delete interviews, or create, list or revoke keys; a leaked one can always be cut off from a signed-in CLI. Live key names are unique, and revoking by name revokes every match.

## Cloud sessions

Claude Code sessions on claude.ai/code run in a VM that never sees this Mac's `~/.claude`, so they need the CLI and a key. Each project's cloud environment gets three things, and `cloud setup` prints all three, ready to paste:

```sh
cd ~/repos/frockbot
kim cloud setup                 # or --project github.com/o/frockbot
kim cloud setup --json          # the same, as JSON
```

It creates an agent key named "<project name> cloud" (`--key-name` picks another). Keys can't be read back, so if a live key already has that name it stops and says so: revoke the old one (`kim key revoke "Frockbot cloud"`) or pass `--key-name`. It needs a signed-in CLI, not a key.

1. **Network access**: Custom, add `keep-it-moving.zerobsai.com`, and keep the default package registries included. The default Trusted level allows GitHub and the registries but not this host.
2. **Environment variables**: `KEEP_IT_MOVING_TOKEN=kim_…`. Anyone who uses the environment can read it.
3. **Setup script**: it installs the CLI from the Worker. Every line ends in `|| true`, so a failure never stops a session from starting:

   ```bash
   #!/bin/bash
   curl -fsS -H "Authorization: Bearer ${KEEP_IT_MOVING_TOKEN:-$INTERVIEWER_TOKEN}" -o /tmp/kim-cli.tgz https://keep-it-moving.zerobsai.com/api/sessions/kim/cli.tgz && npm install -g /tmp/kim-cli.tgz || true
   exit 0
   ```

The CLI package is served behind the agent API at `/api/sessions/kim/cli.tgz`, so the setup script fetches it with the environment's `KEEP_IT_MOVING_TOKEN` and nothing new is public. `npm run build` packs it into `web-dist/cli.tgz` (`scripts/pack-cli.mjs`), with only its runtime dependency, `env-paths`, and fails if the CLI imports a package that isn't a dependency. It stamps the package's `build.json` with a hash of its contents and writes the same to `web-dist/cli-version.json`. The docs don't say whether a setup script sees the environment's variables; if `kim` is missing in a cloud session, that's why, and `/cli.tgz` is public as a fallback.

## On your phone

The interviewer installs as an app. On Android, open the site in Chrome, sign in, and choose **Install app** from the menu; Chrome builds a real app (a WebAPK) that shares Chrome's sign-in cookie. It opens on the interview list.

**Notify me** on that page turns on push notifications for the device. When an interview with nothing open gains questions, the Worker pushes to every subscribed device, and the notification names the interview (for example "FrockBot · Checkout flow, 3 questions waiting") and opens it when tapped. **Send a test** checks the setup.

Pushes carry no data: the Worker signs an empty Web Push with its VAPID key (`VAPID_PUBLIC_KEY` in `wrangler.jsonc`, the private key in the `VAPID_PRIVATE_JWK` secret), and the service worker asks the server what is waiting. The icons, manifest and service worker are public, outside the sign-in, because Google's servers fetch the icons without a sign-in when they build the app.

## Questionnaire behavior

Question widgets include free text, single choice, multiple choice, yes/no, and number. Every widget permits a free-text answer; the widget is input convenience rather than an answer schema. For choice questions, typed text is appended to the selection as `Option — note`. Answered and skipped questions collapse and can be reopened. Editing a question never invalidates its answer automatically.

A question's optional `default` is its recommended answer: one option (or an array for multiple-choice), `"Yes"`/`"No"`, a number, or suggested text. Choice defaults must match an option; matching is case-insensitive and stored with the option's spelling. The browser pre-selects the default, marks it, and labels the primary button "Accept default". "Accept N defaults" in the header saves the default for every open question the user has not edited. Keep `recommendation` for the reasoning; it no longer needs to restate the answer.

A check mark means the service saved the answer. A green question border means the latest revision was written to an attached agent or returned by `events next`. A new revision removes the border until that revision is delivered.

Recommendations are sanitized Markdown, shown while a question is open. Deleted questions disappear from the browser but remain represented in the append-only event history.

## Workspace

An interview usually exists to produce a plan, so a session can carry a workspace beside the questions. There are four kinds of artifact:

- `plan`: the living plan document, in Markdown. There is one per session, and `kim plan` replaces its content.
- `document`: any other Markdown.
- `diagram`: an [archify](https://github.com/tt-a1i/archify) diagram (architecture, workflow, sequence, data flow, or lifecycle), or raw SVG.
- `mockup`: a self-contained HTML page.

```sh
kim plan <session-id> --file plan.md --show
kim artifact add <session-id> --file sync.architecture.json --quality showcase
kim artifact add <session-id> --file layout-a.html --title "Layout A" --description "Sidebar navigation" --show
kim artifact update <session-id> <artifact-id> --file layout-a.html
kim artifact show <session-id> <artifact-id>
kim artifact delete <session-id> <artifact-id>
```

`--kind` is inferred from `.md`, `.svg` and `.html` files, and from archify specs; `--file -` reads stdin. Each content change increments the artifact's revision. Agent-facing responses (`session show`, `wait`, `attach`, `events next`) omit artifact content and source, and report its `size`, since the agent wrote them.

Diagrams come from archify, a separate skill that turns a small typed JSON spec into an interactive HTML viewer. Pass the spec, any JSON file with a `diagram_type`, and the CLI does the rest:

1. It finds the archify skill (`~/.agents`, `~/.claude` or `~/.codex` `skills/archify`, or `KEEP_IT_MOVING_ARCHIFY`).
2. It runs `archify validate`. On failure it exits with archify's diagnostics and supported fixes.
3. It renders the HTML and uploads it along with the spec.

`--quality showcase` applies archify's stricter layout checks. HTML that `archify deliver` already produced can be added with `--kind diagram`, and plain SVG is shown as an image. Mermaid is no longer rendered; older Mermaid diagrams are shown as source.

The workspace column starts closed, because the plan may be followed elsewhere, such as a Markdown file or a design open beside the interviewer. The agent opens or closes it (`kim stage open|close`, or `session create --open-stage`) and the user can toggle it from the header or close it from its own bar. When open, the page has two columns: a sticky stage and the questions. The stage has a tab per artifact; with nothing chosen it shows the plan. The agent (`--show`, `artifact show`) and the user (clicking a tab) can both change what is on screen, and the stage labels who did it. "Expand" hides the questions; Esc restores them.

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
browser ──HTTPS/WSS (Google sign-in)── Worker ── InterviewHub Durable Object per user (SQLite)
```

- **Worker** (`src/worker`): wraps everything in `@cloudflare/workers-oauth-provider`. `/api/sessions/**` needs an OAuth access token or an agent key, and goes to its user's workspace. Every other route needs the browser session from Google sign-in (`/auth/google/start`, `/auth/google/callback`, `/auth/logout`): a random id in an HttpOnly cookie, kept in `OAUTH_KV` for 30 days from last use. Signed-out pages go to `/signin`, signed-out API calls get a 401. `/authorize` completes OAuth straight from that session, and only for loopback redirect URIs, so only the CLI can collect a code. An agent key's owner is recorded in `OAUTH_KV` when it is made; a key with none recorded predates other users and is the owner's.
- **InterviewHub** (`src/worker/hub.ts`): one SQLite Durable Object per user, holding everything of theirs: interviews, projects, agent keys and devices. Tables from features that have since been removed stay in older workspaces, unused. `hubFor` (`src/worker/hubs.ts`) picks it: `user:<email>` for most, and the original `interviews` for `OWNER_EMAIL`. Browser WebSockets hibernate, tagged by session.
- **Hub router and store** (`src/server`): the HTTP API (Hono) and the store, written against a small SQL interface so tests run them on `node:sqlite`.
- **CLI** (`src/cli.ts`): a thin client. `wait` chains 60 s requests with `partial=1` to stay under Cloudflare's 100 s idle cutoff; `attach` filters out the heartbeat lines that keep its stream alive.

The Worker still serves the old interviewer.zerobsai.com while everything moves over; sign-in there moves the browser to keep-it-moving.zerobsai.com.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

The suite runs the hub and store on in-memory `node:sqlite`, and the CLI against them over real HTTP.

## Current limitations

- One watcher per session (the newest takes over).
- Canvas, drawing, uploads, ranking, and rich HTML questions are future work.
