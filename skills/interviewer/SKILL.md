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
- If a command fails with `"code": "plan_limit"`, the user's Free plan refused it; don't retry or work around it. Relay the error to the user in plain words. For too many live interviews (at most 3 at once that an agent is waiting on, or whose open questions a hook asked about in the last 15 minutes), name the interviews in `live` and suggest stopping one they're done with (`kim session stop <id>`) or upgrading at `upgradeUrl`. For assigning, which is Pro only, offer the upgrade or to run the interview with the user instead. When `session create --assign` is refused, the interview was still created, unassigned; its id is in the error.

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

## Interviews sent to the user

Someone else's agent may have assigned your user an interview. When the user asks you to answer interviews sent to them, or `kim inbox` lists some, work through each one with `kim inbox show <interview>`. It gives the questions (type, options, default, recommendation, bound artifact) with any answer, draft and chat thread, the sender's agent's other messages, and the workspace. `<interview>` is the `id` or `url`; `<question>` is a question's id or number.

- **Workspace**: plans and documents come inline. For an html mockup or diagram, `kim inbox artifact <interview> <artifact> --out <file>` saves it as its frame serves it, with saved answers' values applied; read it for detail. To see it, `kim inbox screenshot <interview> <artifact>` has the service render it at its frame's width (`frame` in `show`; `--width 390|834|1280` for another, `--full-page` for all of it) and prints the PNG's path; open that file to look. It's a Pro feature with daily and monthly limits: on a refusal (Free, or screenshots paused), tell the user what it says and read the HTML from `kim inbox artifact` instead. Each artifact has a `revision`, so you can tell what you've already seen.
- **Draft, don't send**: draft each answer from what you know of the user's project and preferences: `kim draft <interview> <question> <answer>`, with `--option <label>` (repeat for multiple-choice) and `--note <text>` for the form's "Other, or add a note", or `--skip`. `--clear` drops a draft. Drafts reach no one until the user sends them in the browser. Only use `--send`, which answers as the user at once, when the user told you to answer directly. A draft is refused if the answer wouldn't fit the question, as the form would refuse it; fix it and try again. Leave questions only the user can answer undrafted.
- **Chat**: `kim inbox chat <interview> [--question <question>] <text>` asks the sender's agent something as the user, sent at once, so only ask what the user would want asked; `--question` puts it in that question's thread. The reply arrives through `kim inbox wait`.
- **Watch**: run `kim inbox wait [<interview>]` in the background, as with `kim wait`. It exits with what is new since you last looked: new questions, the sender's agent's replies, workspace changes (one per artifact, with what `happened` and its `revision`), interviews newly sent to the user (`assigned`: read it with `show`), and `notes` such as a draft written against an older revision of its mockup. Revise drafts as needed, then wait again. `"timedOut": true` means nothing arrived.

When the drafts are in, tell the user to review and send them at the interview's `url` (**Send N drafts**, or edit any first). You can't add questions, artifacts or anything else to someone else's interview.

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

An interview exists to produce a plan, so build the plan alongside it where the user can see it. The workspace has three tabs: **Document** (the plan and Markdown documents, read one at a time), **HTML** (html pages such as mockups, used one at a time at desktop, tablet or phone width) and **Design**, a canvas of the designs (html pages and diagrams; documents stay on the Document tab): every design is a frame the user can pan to, zoom, drag, open at full size on desktop, tablet and phone widths, and pin comments to. Frames lay themselves out in a row per question (the first question that names an artifact by `artifactId` or `optionArtifacts`), after a row of designs tied to no question.

```sh
kim plan <session-id> --file plan.md            # the one living plan (Markdown); replaces content
kim artifact add <session-id> --file sync.architecture.json --quality showcase   # archify spec
kim artifact add <session-id> --file a.html --title "Layout A" --description "Sidebar nav, task list" --show
kim artifact update <session-id> <artifact-id> --file a.html
kim artifact show <session-id> <artifact-id>     # put it on screen
```

- **Plan:** create it early and rewrite it after each batch of answers. Record decisions (what was chosen and why), open questions, and next steps. The user reads it, so keep it short and current.
- **Diagrams:** use one when structure matters, such as architecture, workflow, a request sequence, data flow or state. Diagrams need the [archify](https://github.com/tt-a1i/archify) skill; if it isn't installed, describe the structure in the plan instead, or use a mockup. Author an archify spec by following the archify skill: pick the type, then read its schema and one example. Don't hand-write HTML or run `archify deliver` yourself. Pass the spec to `artifact add` or `artifact update`: it validates, and on failure returns archify's diagnostics with `supportedFixes`, so fix only what they name and retry. Keep the spec file and update it rather than adding near-duplicates. Keep labels meaningful.
- **Mockups:** use self-contained HTML (inline CSS; CDN scripts work), written as real responsive pages: the user previews them at 1280, 834 and 390 wide, and scrolls and clicks through them. Put `data-name="pay button"` (a short, plain name) on each meaningful element, so a comment pinned there names it. A frame is desktop-sized (1280 × 800) unless the title or description says mobile/phone (390 × 844) or tablet (834 × 1112). Always pass `--description`; it keeps the options readable.
- **Whether the workspace is shown:** the workspace column starts closed, and you decide whether to open it. Keep it closed when the user follows the plan somewhere else, for example a Markdown file you are writing in the repo or a design open beside the interviewer, or when the interview is just questions. Open it (`kim stage open <session-id>`, or `session create --open-stage`) when the user should look at something here: a diagram, a mockup to choose between, or a plan they have no other view of. Close it with `kim stage close <session-id>` when it stops being useful. You can change your mind during the session. The user can toggle it too; `stage.visibility` events and `stageVisible` in each batch tell you its state. If the user closed it, don't reopen it unless you are showing something new they need to see.
- **What's on screen:** `--show` (or `artifact show`) takes every viewer to that artifact (its Document or HTML tab, or its frame on the Design canvas), but doesn't open a closed workspace. Don't yank the canvas around while the user is mid-question; show a new item when you ask about it. Focusing a question fits its frames.
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

- **Controls inside one mockup:** for fonts, colours, spacing, copy and small variants, let answers change one mockup live instead of drawing a mockup per option. Keep separate artifacts with `optionArtifacts` for different layouts. Mark what can change in the HTML: a CSS variable (`--accent`, used through `var(--accent)`), a variant attribute (`@nav` is `data-kim-nav`, styled with `[data-kim-nav="top"] …`), or a text slot (`#headline` is `data-kim-text="headline"` on an element holding only text). Point the question's `artifactId` at the mockup. A choice maps options to values with `optionValues` (or `--set '<option>=<control>=<value>'`, repeated). A number sets one variable with a unit and needs `min` and `max` (`--bind --radius --unit px --min 0 --max 24`), and shows a slider. A text question sets one slot (`--bind '#headline'`). Hovering an option previews it in the mockup, a font variable set to a Google Fonts family loads it, and a saved answer stays applied when the mockup is viewed again. Each bound answer in a batch carries `applied: { artifactId, values }`: write those values into the mockup's defaults when you next revise it. An undeclared control is rejected; an `artifact update` that drops one returns `warnings`.

  ```sh
  kim question add <session-id> --prompt "Display font?" --type single-choice --artifact <id> \
    --option Inter --option Fraunces --default Inter \
    --set 'Inter=--font-display=Inter, sans-serif' --set 'Fraunces=--font-display=Fraunces, serif'
  ```

Artifact ids come back from `artifact add`. `session show` lists artifacts without their content.

## Watch and adapt

Run `kim wait <session-id>` in the background. In Claude Code, that means the Bash tool with `run_in_background`: you keep working, and you're woken with its output when the batch arrives. Elsewhere, run it as a background process, or loop on it in the foreground when background processes are unavailable. It exits with one JSON batch when the user pauses (15 s by default, `--idle` to change), or finishes every open question. An empty `events` list means the wait timed out with nothing new. Each batch contains:

- `answers`: the latest answer to each question touched, with `acceptedDefault`. A false value means the user departed from your suggestion, so treat it as a signal to probe.
- `events`: everything queued, including your own edits.
- `openQuestions`: how many questions remain open.
- `messages`: what the user wrote in the interview's chat since the last batch, each with its `messageId`, `text`, and `about` (the question's id, number and prompt) when they asked about a specific question. A comment pinned on the canvas carries `pin`: its number, `artifactId` and `artifact` title, the `element` (its `data-name`, else a short description such as `button "Pay $48.00"`, with a `selector`), and where it is (`x`, `y` in the page's pixels at `width`). Change that element, and reply saying what you changed.
- On an assigned interview, `answeredBy` on an answer and `from` on a message name the assignee who wrote it.

Handle `messages` first: the user is waiting on the reply. A message from the user wakes `wait` straight away.

- **A clarification** ("what do you mean by sync?", "why recommend A?"): answer it with `kim chat reply <session-id> --text "…" --to <messageId>`. Replies are Markdown; keep them short. For more than one paragraph, pass real line breaks: `--file -` with a heredoc, not `\n` inside `--text`. If it shows the question was unclear, also fix the question with `question update`.
- **A direction** ("actually, focus on the mobile app", "skip the pricing questions"): steer by it. Add, update or delete questions and rewrite the plan, then reply briefly to confirm what you changed.

`kim chat list <session-id>` shows the whole thread.

Then handle the rest of the batch: update the plan, adapt the questions, and add or revise visuals. Then run `wait` again. One watcher holds a session at a time; a new one takes over and the old one exits with "Replaced by a newer watcher", so run one `wait` per session. `kim attach` (NDJSON stream) and `kim events next` remain available.

Answers also reach you between your own steps. In Claude Code and Codex, kim's hooks (which kim installs and keeps current itself, unless the user ran `kim hooks uninstall`) bring answers the user gave while you were working, or since your last turn, into your context as a line starting `Keep it moving: answers to interview <id>`, followed by a batch in `wait`'s JSON. Act on an injected batch exactly as on `kim wait` output: it has been delivered, so the next `wait` brings only later answers.

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
