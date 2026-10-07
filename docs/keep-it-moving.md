# Keep it moving

Interviewer is becoming **Keep it moving**: one place to go to keep every running project moving. It shows what each project is aiming for, what its agent sessions are doing, which PRs are ready or red, and what needs Tim. Agents report into it and ask through it.

This spec came out of the interview of 7 October 2026. The mockups are on the Design canvas at https://claude.ai/artifact/5j7K9x1y4uAh5rth2gkcd4.

## Principles

- **A personal layer, not a system of record.** It works over any repo for one person, and nothing in a repo depends on it. Backlogs stay in their tools (GitHub, Linear, Slack); decisions stay in repo files.
- **Two equal users.** Tim uses the browser and phone (PWA with push). Agents use the CLI. Every feature gets both a screen and a CLI verb.
- **Hosted.** It runs as one Cloudflare Worker and one SQLite Durable Object (`InterviewHub`) at interviewer.zerobsai.com. The browser goes through Access; the CLI goes through OAuth (`/api/sessions/*`). All state lives in the Durable Object, so local and cloud sessions reach the same thing. The server can't see Tim's machines, so they push to it.
- **Light actions only.** Answer a request, triage a follow-up, send something to a session. Nothing here starts, stops or merges anything.
- **Ship fast, change as we go.** One user, so deploy each feature when it lands.

## Concepts

| Concept           | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project**       | The existing `projects` table, keyed by normalised git remote (`github.com/owner/repo`). It gains a GitHub repo (derived from the key), backlog settings and a milestone.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Agent session** | One Claude Code (later Codex or Pi) session. It is keyed by the agent's own session id (`CLAUDE_CODE_SESSION_ID` or the hook's `session_id`). It has a project, title, status (`running`, `needs_you`, `idle`, `done`), agent, location (local or cloud), machine, branch, worktree, an optional PR, and the last brief it reported. A cloud session also carries its claude.ai id (`CLAUDE_CODE_REMOTE_SESSION_ID`, `cse_…`), which links to its page and lets `report` and `ask` find it.                                                                                                           |
| **Request**       | An interview (the existing `sessions` table) that an agent session raised. Its `origin.agentSessionId` links it to that session. A request is a small interview: a brief plus any questions and artifacts. The agent stays parked in `wait` until Tim answers. A planning interview is the same thing, just bigger.                                                                                                                                                                                                                                                                                   |
| **Inbox item**    | Something that needs Tim, derived on the server, oldest first: a request with open questions · an agent session in `needs_you` · a failed CI check on an open PR · an automation that missed 2 check-ins · open follow-ups · PRs ready to merge. Inbox items push to the phone.                                                                                                                                                                                                                                                                                                                       |
| **Follow-up**     | Something a finished session left undone. Tim triages it: send it to the backlog, start a session on it, or dismiss it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Automation**    | A long-running loop (the per-project `/loop /babysitter`, crons). It registers with an expected interval and sends `heartbeat`s, and is marked down after 2 missed check-ins.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Machine**       | A computer that runs the CLI. Every CLI call from it counts as a heartbeat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **PR**            | Read from GitHub on the server (a `GITHUB_TOKEN` Worker secret): checks, mergeable state, reviews, files and patches. "Ready" means GitHub's verdict: mergeable, checks green, reviews met. A PR links to its agent session (by branch or reported URL) and its backlog item.                                                                                                                                                                                                                                                                                                                         |
| **Backlog item**  | A normalised item: source id, title, status, URL, milestone, priority and order, assignee, labels, body, plus links to the sessions and PRs on it. GitHub Issues sync is built in. Other sources (Linear, Slack) use a **per-project sync script** that an agent writes at setup. The workbench stores it, `backlog sync <project>` runs it locally, and the CLI uploads its JSON output. Reading is the default; it writes back to the source only when Tim accepts something, and a per-project setting can turn on automatic writes. Sync runs on demand, and again before an agent picks up work. |
| **Milestone**     | Taken from the source when it has one (a GitHub milestone, a Linear cycle or project); otherwise defined in the workbench. Each project shows one current milestone with its progress.                                                                                                                                                                                                                                                                                                                                                                                                                |

## Screens

All screens share one shell: a dark top bar ("Keep it moving", counts, ⌘K switcher), a **project rail** on the left, and content on the right. The rail lists each project compactly: a colour, its name, its milestone, and icon counts for needs-you, running sessions, open PRs, CI state, babysitter heartbeat and milestone progress. At phone width the rail stacks above the content.

- **Inbox** (`/`): a list to work through, oldest first. Selecting an item shows it on the right: its brief, then what it needs, which varies by kind. A request shows its questions inline, answered with the existing widgets. A CI failure shows the failing checks and a log excerpt. Follow-ups get Backlog, Start and Dismiss. An automation shows its expected interval and last beat. A ready PR shows its diff stats. Every item has **Done → next** and **Snooze**.
- **Project** (`/p/<projectId>`): the milestone with its progress bar and "where it's up to" (the latest summary, with what it's based on), sessions, pull requests, up next (the backlog in milestone order, plus Sync now), and automations and machines.
- **PR** (`/p/<projectId>/pr/<number>`): checks with the failing log excerpt, the full diff with a file tree, the summary and risk, its session and backlog item, and the babysitter state.
- **Interview** (`/s/<token>`): unchanged.

## How agents report (CLI)

The binary stays `interviewer`, with a `kim` alias. The domain stays.

- `kim hook <event>` reads the Claude Code hook JSON from stdin and reports it:
  - `SessionStart` → running
  - `UserPromptSubmit` → running
  - `Notification` → needs_you, with the message
  - `Stop` → idle, with the brief taken from the transcript's last assistant message
  - `SessionEnd` → done

  It never blocks and never fails the hook: it exits 0 quickly and swallows errors.

- `kim hooks install` adds those hooks to `~/.claude/settings.json` next to the hooks already there. It merges and never replaces, and it's idempotent.
- `kim report --status … --brief … --pr <url> --follow-up "…"` (repeatable) lets an agent report explicitly. It finds the session from `CLAUDE_CODE_SESSION_ID`.
- `kim ask` is `session create` plus `question add` plus `wait`, already linked to the calling agent session: one command to raise a request and park.
- `kim heartbeat <automation> --project <key> --every 5m` registers an automation and beats.
- `kim backlog sync <project>`, `kim backlog script set <project> --file sync.mjs`, `kim backlog next <project>`.

## Build waves

1. **Foundation:** agent sessions, hooks and `report`; requests linked to sessions; the inbox API with push; the new shell with the project rail, inbox and project page (sessions and requests). Deploy.
2. In parallel:
   - **PRs and CI:** the GitHub client, the PR list and status, ready-to-merge, the diff view, and CI and ready-PR inbox items.
   - **Automations and machines:** heartbeats, missed check-in detection (Durable Object alarm), and inbox items for automations that are down.
   - **Backlog, milestones and follow-ups:** GitHub Issues sync, per-project sync scripts, milestones, the up-next list and follow-up triage.
3. **Polish:** a Worker-side Claude summary fallback, Codex and Pi hooks, and anything Tim asks for once he's using it.
