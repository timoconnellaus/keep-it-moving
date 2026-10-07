---
name: interviewer
description: Conduct a persistent browser-based interview and live planning session with adaptive questions, recommended defaults, a living plan document, diagrams, and mockups. Use when gathering structured requirements or decisions from the user, working out a plan with them, or when /grill-me should run through the local interviewer UI.
---

# Interviewer

Use the `interviewer` CLI to run an adaptive interview in the user's browser.

## Start or resume

1. From the repository the interview is about, run `interviewer session create --title "<concise interview title>" --agent-session "<your session's title>"` and retain the returned session ID and URL. To continue a stopped interview, run `interviewer session resume <id>` instead. If a command says you are not signed in, ask the user to run `interviewer login` in their own terminal.

   The user switches between interviews from many agent sessions, grouped by project. The CLI works out the project from the git remote, plus the branch, worktree and agent, so run it inside the repo. Pass `--agent-session` with the title of your conversation or task so the user can tell your interview apart. If the returned `project` is null or wrong (no remote, or a scratch folder), run `interviewer project list` and pass `--project "<name>"` to use the right one.

2. Add the currently useful frontier of questions. Use simple flags for one question or JSON over stdin for rich questions and batches:

   ```sh
   interviewer question add <session-id> --prompt "..." --type single-choice --option "..." --option "..." --default "..." --recommendation "..."
   interviewer question add <session-id> --json - <<'JSON'
   {"questions":[{"type":"multiple-choice","prompt":"...","options":["A","B","C"],"default":["A","C"],"recommendation":"..."}]}
   JSON
   ```

3. Open the returned URL when browser-opening capability is available; otherwise give the URL to the user.

Question types are `text`, `single-choice`, `multiple-choice`, `yes-no`, and `number`. Every widget accepts a free-text answer; for choice questions a typed note arrives appended as `Option — note`.

For genuine decisions, set `default` to the answer you recommend, and use `recommendation` (Markdown) for the short reasoning. The browser pre-selects the default and offers one-click and bulk acceptance, so a good default saves the user time. A default is exactly one option for `single-choice`, one or more options for `multiple-choice`, `"Yes"`/`"No"` for `yes-no`, a number for `number`, or suggested text for `text`. Omit both when asking for facts only the user knows. An answer equal to the default means the user accepted it.

## A quick request instead

When you're blocked on a decision or something only the user can do, and a full interview is more than you need, raise a request with one command. It creates an interview linked to your Claude Code session (so it shows in the user's Keep it moving inbox with your brief), marks your session as needing them, and waits for the answers:

```sh
interviewer ask --title "Run the migration against prod D1?" \
  --brief "The migration is written and tested locally. Prod has no backup from today." \
  --json - <<'JSON'
{"questions":[{"type":"single-choice","prompt":"Run it now?","options":["Back up first, then run","Run without a backup","Stop, I'll look myself"],"default":"Back up first, then run"}]}
JSON
```

The brief says what you were doing, what's blocked and what you need, in two or three sentences. The URL goes to stderr; stdout gets one batch like `wait`'s, plus `interviewId`. If it times out before the user answers, run `interviewer wait <interviewId>` (in the background if you can). Everything else in this skill (adding questions, the plan, `session stop`) works on the request too.

`interviewer report --status … --brief … --pr <url> --follow-up "…"` reports progress explicitly; the hooks from `interviewer hooks install` already report the routine changes.

## Workspace: plan, diagrams, mockups

An interview exists to produce a plan, so build the plan alongside it where the user can see it:

```sh
interviewer plan <session-id> --file plan.md            # the one living plan (Markdown); replaces content
interviewer artifact add <session-id> --file sync.architecture.json --quality showcase   # archify spec
interviewer artifact add <session-id> --file a.html --title "Layout A" --description "Sidebar nav, task list" --show
interviewer artifact update <session-id> <artifact-id> --file a.html
interviewer artifact show <session-id> <artifact-id>     # put it on screen
```

- **Plan:** create it early and rewrite it after each batch of answers. Record decisions (what was chosen and why), open questions, and next steps. The user reads it, so keep it short and current.
- **Diagrams:** use one when structure matters, such as architecture, workflow, a request sequence, data flow or state. Author an archify spec by following the archify skill: pick the type, then read its schema and one example. Don't hand-write HTML or run `archify deliver` yourself. Pass the spec to `artifact add` or `artifact update`: it validates, and on failure returns archify's diagnostics with `supportedFixes`, so fix only what they name and retry. Keep the spec file and update it rather than adding near-duplicates. Keep labels meaningful.
- **Mockups:** use self-contained HTML (inline CSS; CDN scripts work). Always pass `--description`; it keeps the options readable.
- **Whether the workspace is shown:** the workspace column starts closed, and you decide whether to open it. Keep it closed when the user follows the plan somewhere else, for example a Markdown file you are writing in the repo or a design open beside the interviewer, or when the interview is just questions. Open it (`interviewer stage open <session-id>`, or `session create --open-stage`) when the user should look at something here: a diagram, a mockup to choose between, or a plan they have no other view of. Close it with `interviewer stage close <session-id>` when it stops being useful. You can change your mind during the session. The user can toggle it too; `stage.visibility` events and `stageVisible` in each batch tell you its state. If the user closed it, don't reopen it unless you are showing something new they need to see.
- **What's on screen:** `--show` switches the workspace to an item, but doesn't open a closed workspace. Don't yank the screen around while the user is mid-question; show a new item when you ask about it.
- **Linking questions:** set `artifactId` on a question that is about an artifact. Focusing that question brings the artifact on screen. For a choice between visuals, map options to artifacts with `optionArtifacts`, and they render as cards with thumbnails:

  ```json
  {
    "type": "single-choice",
    "prompt": "Which layout?",
    "options": ["Sidebar", "Board"],
    "optionArtifacts": { "Sidebar": "<id>", "Board": "<id>" },
    "default": "Sidebar"
  }
  ```

Artifact ids come back from `artifact add`. `session show` lists artifacts without their content.

## Watch and adapt

Run `interviewer wait <session-id>` as a background process. It exits with one JSON batch when the user pauses (15 s by default, `--idle` to change), or finishes every open question. An empty `events` list means the wait timed out with nothing new. Each batch contains:

- `answers`: the latest answer to each question touched, with `acceptedDefault`. A false value means the user departed from your suggestion, so treat it as a signal to probe.
- `events`: everything queued, including your own edits.
- `openQuestions`: how many questions remain open.

Handle the batch: update the plan, adapt the questions, and add or revise visuals. Then run `wait` again. One watcher holds a session at a time; a new one takes over and the old one exits with "Replaced by a newer watcher", so never run two. If background processes are unavailable, loop on `interviewer wait` in the foreground. `interviewer attach` (NDJSON stream) and `interviewer events next` remain available.

Answers can arrive while detached and appear in the next batch. Treat `answer.revised` as a fresh decision point. Decide whether later questions should remain, change, or be deleted; there is no automatic dependency system.

Adapt through the CLI:

```sh
interviewer question add <session-id> ...
interviewer question update <session-id> <question-id> --json '{...}'
interviewer question reorder <session-id> <question-id> --position <n>
interviewer question focus <session-id> <question-id>
interviewer question delete <session-id> <question-id>
```

## Finish

Stop the interview when its decision frontier is empty:

```sh
interviewer session stop <session-id>
```

A stopped interview is review-only. Use `interviewer session resume <session-id>` before adding questions or collecting more answers. Cancelling `attach` only releases the watcher; it does not stop the interview.
