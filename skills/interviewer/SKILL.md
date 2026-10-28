---
name: interviewer
description: Conduct a persistent browser-based interview and live planning session with adaptive questions, recommended defaults, a living plan document, diagrams, and mockups, through the Keep it moving CLI (`kim`). Use when gathering structured requirements or decisions from the user, working out a plan with them, or when they ask to be interviewed or grilled ("interview me about…", "grill me about…").
---

# Interviewer

Use the `kim` CLI (Keep it moving) to run an adaptive interview in the user's browser. The user answers there, beside a plan you keep up to date, while you wait for their answers and adapt.

## Before you start

- If `kim` isn't installed, ask the user to install it (Node.js 22.13 or newer): `npm install -g https://keep-it-moving.zerobsai.com/cli.tgz`.
- If a command says the CLI isn't signed in, ask the user to run `kim login` in their own terminal; it signs in with Google in the browser. `kim whoami` checks.
- If `kim` says on stderr that an update is available, mention it to the user; `kim update` installs it.

## Start or resume

1. From the repository the interview is about, run `kim session create --title "<concise interview title>" --agent-session "<your session's title>"` and retain the returned session ID and URL. To continue a stopped interview, run `kim session resume <id>` instead.

   The user may have interviews from several agent sessions, grouped by project. The CLI works out the project from the git remote, plus the branch, worktree and agent, so run it inside the repo when there is one. Pass `--agent-session` with the title of your conversation or task so the user can tell your interview apart. If the returned `project` is null or wrong (no remote, or a scratch folder) and the interview belongs to an existing project, run `kim project list` and pass `--project "<name>"`.

2. Add the currently useful frontier of questions. Use simple flags for one question or JSON over stdin for rich questions and batches:

   ```sh
   kim question add <session-id> --prompt "..." --type single-choice --option "..." --option "..." --default "..." --recommendation "..."
   kim question add <session-id> --json - <<'JSON'
   {"questions":[{"type":"multiple-choice","prompt":"...","options":["A","B","C"],"default":["A","C"],"recommendation":"..."}]}
   JSON
   ```

3. Open the returned URL when browser-opening capability is available; otherwise give the URL to the user.

## Someone else answers it

When the user wants another person to fill in an interview (a client, a colleague), assign it to that person's email: `kim session create … --assign <email>`, or `kim session assign <session-id> <email>` for an existing one (`--clear` takes it back; one assignee at a time). Give the user the returned `url` to send them; nothing is emailed. That person signs in with Google as exactly that email and sees only this interview: its questions, the workspace items you show, and the chat. Write the questions for them, not the user.

Then wait as usual. Their answers and chat messages come back in `wait` batches with `answeredBy` (on answers) and `from` (on messages) set to their email; reply in the chat as you would to the user. They may take hours or days, so keep the background `kim wait` loop going while your session lasts, and before you stop, tell the user the session ID and that `kim wait <session-id>` picks up their answers later. The user's home page shows the interview as waiting on the assignee, and their phone is notified when answers arrive.

Question types are `text`, `single-choice`, `multiple-choice`, `yes-no`, and `number`. Every widget accepts a free-text answer; for choice questions a typed note arrives appended as `Option — note`.

For genuine decisions, set `default` to the answer you recommend, and use `recommendation` (Markdown) for the short reasoning. The browser pre-selects the default and offers one-click and bulk acceptance, so a good default saves the user time. A default is exactly one option for `single-choice`, one or more options for `multiple-choice`, `"Yes"`/`"No"` for `yes-no`, a number for `number`, or suggested text for `text`. Omit both when asking for facts only the user knows. An answer equal to the default means the user accepted it.

## A quick question instead

When you're blocked on a decision or something only the user can do, and a full interview is more than you need, ask with one command. It creates an interview with your questions and waits for the answers:

```sh
kim ask --title "Run the migration against prod D1?" --json - <<'JSON'
{"questions":[{"type":"single-choice","prompt":"Run it now?","options":["Back up first, then run","Run without a backup","Stop, I'll look myself"],"default":"Back up first, then run","recommendation":"The migration is tested locally, but prod has no backup from today."}]}
JSON
```

Put what you were doing and what's blocked in the question's `recommendation` or prompt. The URL goes to stderr; stdout gets one batch like `wait`'s, plus `interviewId`. If it times out before the user answers, run `kim wait <interviewId>` (in the background if you can). Everything else in this skill (adding questions, the plan, `session stop`) works on it too.

In a claude.ai cloud session, the CLI authenticates with the environment's `KEEP_IT_MOVING_TOKEN`. If `kim` isn't installed or the host is unreachable there, the environment isn't set up: tell the user to run `kim cloud setup` from the repo on their own machine, rather than trying to install or sign in yourself. Never print or commit `KEEP_IT_MOVING_TOKEN`.

## Workspace: plan, diagrams, mockups

An interview exists to produce a plan, so build the plan alongside it where the user can see it:

```sh
kim plan <session-id> --file plan.md            # the one living plan (Markdown); replaces content
kim artifact add <session-id> --file sync.architecture.json --quality showcase   # archify spec
kim artifact add <session-id> --file a.html --title "Layout A" --description "Sidebar nav, task list" --show
kim artifact update <session-id> <artifact-id> --file a.html
kim artifact show <session-id> <artifact-id>     # put it on screen
```

- **Plan:** create it early and rewrite it after each batch of answers. Record decisions (what was chosen and why), open questions, and next steps. The user reads it, so keep it short and current.
- **Diagrams:** use one when structure matters, such as architecture, workflow, a request sequence, data flow or state. Diagrams need the [archify](https://github.com/tt-a1i/archify) skill; if it isn't installed, describe the structure in the plan instead, or use a mockup. Author an archify spec by following the archify skill: pick the type, then read its schema and one example. Don't hand-write HTML or run `archify deliver` yourself. Pass the spec to `artifact add` or `artifact update`: it validates, and on failure returns archify's diagnostics with `supportedFixes`, so fix only what they name and retry. Keep the spec file and update it rather than adding near-duplicates. Keep labels meaningful.
- **Mockups:** use self-contained HTML (inline CSS; CDN scripts work). Always pass `--description`; it keeps the options readable.
- **Whether the workspace is shown:** the workspace column starts closed, and you decide whether to open it. Keep it closed when the user follows the plan somewhere else, for example a Markdown file you are writing in the repo or a design open beside the interviewer, or when the interview is just questions. Open it (`kim stage open <session-id>`, or `session create --open-stage`) when the user should look at something here: a diagram, a mockup to choose between, or a plan they have no other view of. Close it with `kim stage close <session-id>` when it stops being useful. You can change your mind during the session. The user can toggle it too; `stage.visibility` events and `stageVisible` in each batch tell you its state. If the user closed it, don't reopen it unless you are showing something new they need to see.
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

Run `kim wait <session-id>` as a background process. It exits with one JSON batch when the user pauses (15 s by default, `--idle` to change), or finishes every open question. An empty `events` list means the wait timed out with nothing new. Each batch contains:

- `answers`: the latest answer to each question touched, with `acceptedDefault`. A false value means the user departed from your suggestion, so treat it as a signal to probe.
- `events`: everything queued, including your own edits.
- `openQuestions`: how many questions remain open.
- `messages`: what the user wrote in the interview's chat since the last batch, each with its `messageId`, `text`, and `about` (the question's id, number and prompt) when they asked about a specific question.
- On an assigned interview, `answeredBy` on an answer and `from` on a message name the assignee who wrote it.

Handle `messages` first: the user is waiting on the reply. A message from the user wakes `wait` straight away.

- **A clarification** ("what do you mean by sync?", "why recommend A?"): answer it with `kim chat reply <session-id> --text "…" --to <messageId>`. Replies are Markdown; keep them short. If it shows the question was unclear, also fix the question with `question update`.
- **A direction** ("actually, focus on the mobile app", "skip the pricing questions"): steer by it. Add, update or delete questions and rewrite the plan, then reply briefly to confirm what you changed.

`kim chat list <session-id>` shows the whole thread.

Then handle the rest of the batch: update the plan, adapt the questions, and add or revise visuals. Then run `wait` again. One watcher holds a session at a time; a new one takes over and the old one exits with "Replaced by a newer watcher", so never run two. If background processes are unavailable, loop on `kim wait` in the foreground. `kim attach` (NDJSON stream) and `kim events next` remain available.

Answers can arrive while detached and appear in the next batch. Treat `answer.revised` as a fresh decision point. Decide whether later questions should remain, change, or be deleted; there is no automatic dependency system.

Adapt through the CLI:

```sh
kim question add <session-id> ...
kim question update <session-id> <question-id> --json '{...}'
kim question reorder <session-id> <question-id> --position <n>
kim question focus <session-id> <question-id>
kim question delete <session-id> <question-id>
```

## Finish

Stop the interview when its decision frontier is empty:

```sh
kim session stop <session-id>
```

A stopped interview is review-only. Use `kim session resume <session-id>` before adding questions or collecting more answers. Cancelling `attach` only releases the watcher; it does not stop the interview.
