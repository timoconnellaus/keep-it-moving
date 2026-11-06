# Plan: a better model connection to interviews

**Goal:** the agent can do other work during an interview and still sees every answer. When it has nothing else to do, it waits for answers. The only way it can finish while an interview is running is to end the interview.

## What Claude Code gives us (in plain terms)

A **hook** is a small command Claude Code runs at set moments. It can hand text to the model, or refuse to let the model stop. These are the ones that matter here:

| Tool                                | When it runs                            | What it can do for us                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PostToolUse** hook                | After every tool call the model makes   | Slip new answers into the model's context mid-task _(kim already does this, at most once every 15 s)_                                                                                                                                                                                                                                  |
| **UserPromptSubmit** hook           | When you type in the terminal           | Bring in answers you gave since the last turn _(already done)_                                                                                                                                                                                                                                                                         |
| **Stop** hook                       | When the model tries to finish its turn | **Refuse to stop** (`decision: block`) and give the model a reason, which can be the answers. It can run for a long time (default limit 10 min, configurable). After 8 refusals in a row with no tool calls in between, Claude Code overrides it and lets the model stop. Pressing Esc interrupts, and the Stop hook doesn't run then. |
| **Async + asyncRewake** hook        | Runs in the background, never blocks    | Can **wake an idle Claude** later by exiting with code 2. A newer feature; needs a test on your setup.                                                                                                                                                                                                                                 |
| Background `kim wait` / **Monitor** | Something the model starts itself       | Wakes the model when output arrives. This is today's approach, and it relies on the model remembering to start it.                                                                                                                                                                                                                     |
| **Channels** (MCP push)             | Any time                                | A true push into the session, but it's a research preview behind a `--channels` flag. Not viable as the default yet.                                                                                                                                                                                                                   |

Each hook is told the **session id**, and commands the model runs see `CLAUDE_CODE_SESSION_ID`, so kim can pin exactly one interview to one session.

**Codex** has Stop (block → continue, with the reason used as the next prompt), PostToolUse, UserPromptSubmit and SessionStart, but no async-rewake, so the same design works there minus the "sleep and wake" option.

## What exists today

- Hooks: SessionStart, UserPromptSubmit, PostToolUse. A session binds to _any_ interview it touches (several at once).
- **Read receipts mostly exist already:** when a hook or wait takes answers, the server marks them `delivered`, and the browser shows "Sent to the agent" plus "Agent is watching / away".
- Waiting depends on the model running `kim wait` in the background.

## Gaps

1. No **Stop** hook, so the agent can end its turn mid-interview and nothing brings it back.
2. No one-interview-per-session rule.
3. The "read" signal is subtle, and it says nothing about _how_ the answer reached the agent.

## Design

1. **One live interview per Claude session**, keyed on the hook `session_id`. A second `session create`/`ask`/`resume` is refused and names the running one. Inbox interviews don't count.
2. **Waiting = sleep and wake (Claude).** The effect matches Orca's, done with Claude Code's own hooks:
   - When Claude ends its turn with a live interview, a **Stop hook** first checks for answers that are already waiting. If there are any, it **blocks** the stop and hands them over at once.
   - Otherwise it allows the stop, and an **async `asyncRewake` hook** waits on the server in the background. When answers land, it exits with code 2 and **wakes Claude** with them. The prompt stays free, so you can type any time.
   - It re-arms on every stop. Only `kim session stop` turns it off.
3. **Codex: Hold.** Its Stop hook long-polls, then blocks with the answers as the next prompt.
4. **Mid-task delivery** stays on PostToolUse (Claude and Codex).
5. **Read receipts:** "read" means the answer is in the model's context. The server already records `delivered`; the UI shows it clearly.
6. `kim wait` remains for deliberate waiting.

## Decisions

- **Scope:** Claude Code now; Codex wherever its hooks allow the same.
- **Second interview in a session:** refused, naming the running one.
- **Inbox interviews:** light touch. They inject news but never hold or wake.
- **"Read"** = the answer or message is in the model's context (a hook or wait delivered it).
- **Waiting:** sleep and wake for Claude (asyncRewake); Hold for Codex.
- **Long quiet spells:** keep waiting indefinitely. The waiter re-arms itself, and only ending the interview turns it off.
- **Mid-task delivery:** at the next tool call, with no 15 s throttle.
- **Read UI:** a tick on each answer and chat message, "Read by agent · <time>".
- **Presence:** a single green **connected** dot. Connected means the background waiter is open, or a hook checked in within the last few minutes. Otherwise it's grey ("Agent is away"). A SessionEnd hook turns it grey straight away.
- **Session closed or crashed:** the interview stays open and answers wait for the next session (`kim session resume`).
- **Skill:** "With nothing else to do, end your turn; kim wakes you." `kim wait` is only for agents without kim's hooks.
- **Cost:** the waiter reuses `kim wait`'s hibernating WebSocket, which costs fractions of a cent per day. Waiter timeouts are long (hours), so reconnects stay rare.

## Spike results (2026-11-06, Claude Code 2.1.318)

- An async Stop hook with `asyncRewake: true` that exits 2 **wakes an idle Claude**. Only **stderr** reaches the model (stdout is ignored), inside a system reminder that starts with `rewakeMessage`. The terminal shows `rewakeSummary`.
- The woken turn's own Stop **re-arms** the hook by itself.
- When the hook hits its `timeout`, it gets SIGTERM and **doesn't wake** anything. So the waiter wakes the model with "still waiting" shortly before its 24 h timeout.

## Build steps (all done)

1. **Spike asyncRewake** in a scratch Claude session: wake on exit 2, how the text reaches the model, timeout behaviour, and interplay with typing.
2. **One interview per session:** bindings keyed by `session_id`; `create`/`ask`/`resume` refused while one is live; inbox exempt.
3. **Stop hook (Claude):** hand over pending answers by blocking. Otherwise arm the background `kim hook wait` (asyncRewake), which reuses the `kim wait` socket. `UserPromptSubmit` disarms a running waiter, so a turn you start yourself doesn't race it.
4. **Stop hook (Codex):** Hold, by long-polling and then blocking with the answers as the next prompt.
5. **PostToolUse:** check on every tool call (drop the throttle; keep the 2 s cap).
6. **Server + UI:** a delivered time on answers and messages, read ticks, the connected dot, and SessionEnd → away.
7. **Skill text** and `kim hooks install` updated; tests for each hook path.
