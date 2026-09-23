---
name: interviewer
description: Conduct a persistent browser-based interview and live planning session with adaptive questions, recommended defaults, a living plan document, diagrams, mockups, and a voice companion. Use when gathering structured requirements or decisions from the user, working out a plan with them, or when /grill-me should run through the local interviewer UI.
---

# Interviewer

Use the `interviewer` CLI to run an adaptive interview in the user's browser.

## Start or resume

1. Run `interviewer session create --title "<concise interview title>"` and retain the returned session ID and URL. To continue a stopped interview, run `interviewer session resume <id>` instead.
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

## Workspace: plan, diagrams, mockups

An interview exists to produce a plan, so build the plan alongside it where the user can see it:

```sh
interviewer plan <session-id> --file plan.md            # the one living plan (Markdown); replaces content
interviewer artifact add <session-id> --file sync.architecture.json --quality showcase   # archify spec
interviewer artifact add <session-id> --file a.html --title "Layout A" --description "Sidebar nav, task list" --show
interviewer artifact update <session-id> <artifact-id> --file a.html
interviewer artifact show <session-id> <artifact-id>     # put it on screen
```

- **Plan:** create it early and rewrite it after each batch of answers. Record decisions (what was chosen and why), open questions, and next steps. The user and voice both read it, so keep it short and current.
- **Diagrams:** use one when structure matters, such as architecture, workflow, a request sequence, data flow or state. Author an archify spec by following the archify skill: pick the type, then read its schema and one example. Don't hand-write HTML or run `archify deliver` yourself. Pass the spec to `artifact add` or `artifact update`: it validates, and on failure returns archify's diagnostics with `supportedFixes`, so fix only what they name and retry. Keep the spec file and update it rather than adding near-duplicates. Voice reads the spec, so keep labels meaningful.
- **Mockups:** use self-contained HTML (inline CSS; CDN scripts work). Always pass `--description`, because voice uses it and it keeps the options readable.
- **What's on screen:** `--show` switches the stage to an item. Don't yank the screen around while the user is mid-question; show a new item when you ask about it.
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

- **Walking the user through it:** after adding or changing something the user should look at, send `interviewer note <session-id> --text "…" --speak` so voice introduces it.

Artifact ids come back from `artifact add`. `session show` lists artifacts without their content.

## Watch and adapt

Run `interviewer wait <session-id>` as a background process. It exits with one JSON batch when the user pauses (15 s by default, `--idle` to change), finishes every open question, or voice needs a clarification. An empty `events` list means the wait timed out with nothing new. Each batch contains:

- `answers`: the latest answer to each question touched, with `acceptedDefault`. A false value means the user departed from your suggestion, so treat it as a signal to probe.
- `notes`: things the user said by voice that matter for the plan but aren't answers, such as new requirements, concerns, or requests for a question, diagram, or mockup. Act on them: add the question, draw the diagram, or update the plan.
- `events`: everything queued, including your own edits.
- `openQuestions`: how many questions remain open.

Handle the batch: update the plan, adapt the questions, and add or revise visuals. Then run `wait` again. Only one watcher may attach at a time. If background processes are unavailable, loop on `interviewer wait` in the foreground. `interviewer attach` (NDJSON stream) and `interviewer events next` remain available.

Answers can arrive while detached and appear in the next batch. Treat `answer.revised` as a fresh decision point. Decide whether later questions should remain, change, or be deleted; there is no automatic dependency system.

Adapt through the CLI:

```sh
interviewer question add <session-id> ...
interviewer question update <session-id> <question-id> --json '{...}'
interviewer question reorder <session-id> <question-id> --position <n>
interviewer question focus <session-id> <question-id>
interviewer question delete <session-id> <question-id>
```

The voice companion learns about your added and changed questions silently, and mentions them at a natural pause. To tell it something directly, send a note. `--speak` asks it to relay the note to the user as soon as it is quiet:

```sh
interviewer note <session-id> --text "..." [--question <question-id>] [--speak]
```

For a `clarification.requested` event, answer promptly with useful context, because voice is waiting on it:

```sh
interviewer clarification reply <session-id> <request-id> --text "..."
```

The request remains pending in Gemini until this result arrives. Clarification content is voice context and does not appear in the questionnaire.

If the page reports that voice needs a Gemini API key, ask the user to run `interviewer config gemini-key` in their own terminal. Never ask them to paste the key into the conversation.

## Finish

Stop the interview when its decision frontier is empty:

```sh
interviewer session stop <session-id>
```

A stopped interview is review-only. Use `interviewer session resume <session-id>` before adding questions or collecting more answers. Cancelling `attach` only releases the watcher; it does not stop the interview.
