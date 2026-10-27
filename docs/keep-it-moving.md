# Keep it moving

Keep it moving is where agents interview people. An agent asks questions in the browser, beside a living plan, diagrams and mockups, and waits for the answers; the person answers, chats with the agent, or hands the interview to someone else. The home page lists every interview and what's left to do on it.

It began as Interviewer, grew into a workbench for every running project (an inbox, agent-session tracking, PRs and CI, automations, backlogs), and was wound back to interviews on 27 October 2026: the interview process was the only part in use.

## Principles

- **A personal layer, not a system of record.** It works over any repo for each person who signs in, each in a private workspace of their own, and nothing in a repo depends on it. The one opening is an interview its owner assigns to someone else's email: that person answers it, and sees nothing else of the workspace. Decisions stay in repo files.
- **Two equal users.** People use the browser and phone (PWA with push). Agents use the CLI. Every feature gets both a screen and a CLI verb.
- **Hosted.** It runs as one Cloudflare Worker and a SQLite Durable Object (`InterviewHub`) per user at keep-it-moving.zerobsai.com. The browser signs in with Google, run by the Worker; the CLI goes through OAuth (`/api/sessions/*`), or an agent key in a cloud session. Each user's state lives in their own Durable Object, so their local and cloud sessions reach the same thing.
- **No destructive migrations.** Workspaces from the workbench era keep its tables; nothing reads them.

## Concepts

| Concept       | What it is                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Interview** | A session (the `sessions` table): a title, questions and answers, artifacts (the plan, documents, diagrams, mockups) on a stage, and one chat thread with the agent. Active or stopped. Its secret token is its page, `/s/<token>`.        |
| **Project**   | A label on an interview: the normalised git remote (`github.com/owner/repo`) the CLI detects at creation, with a name and a fixed colour. `--project <name>` picks an existing one.                                                        |
| **Assignee**  | Someone else's email an interview is assigned to. They sign in with Google as that email, see only that interview (under "Shared with you" on their home page), and their answers and messages come back to the owner's agent, attributed. |
| **Agent key** | A long-lived, revocable credential for a cloud session's environment (`KEEP_IT_MOVING_TOKEN`). It can work on interviews, but not answer, delete or manage keys.                                                                           |

## Who an interview waits on

- **You**, while it has open questions and isn't assigned.
- **The assignee**, while an assigned interview has open questions.
- **The agent**, once nothing is open, or whenever the latest chat message is the user's (or the assignee's) and the agent hasn't replied.
- **Nobody**, once it is stopped.

## Screens

- **Home** (`/`): a top bar (the account menu and **Notify me**), then every interview, one row each: title, project, "N of M answered" with a bar, who it waits on, whom it's assigned to and its last activity. Waiting on you first, then other active ones, then stopped ones; newest activity first within each. Interviews others assigned to you sit above, under **Shared with you**. It updates live and works at phone width.
- **Interview** (`/s/<token>`): the questions, the stage, the chat, **Assign**, and a ⌘K switcher over the same list.

Push notifications go to the owner's devices when an interview starts waiting on them, when the agent replies in the chat, and when an assignee answers.

## CLI

The binary is `kim`, with `interviewer` as an alias. Everything an interview needs: `session create|list|show|stop|resume|assign|delete`, `question add|update|delete|focus|reorder`, `plan`, `artifact`, `stage`, `chat`, `wait`, `attach`, `events next`, and `ask` (create, add questions and wait in one). `session delete` takes several ids, or `--stopped` for every stopped interview. `login`, `logout` and `whoami` handle sign-in; `key` and `cloud setup` set up cloud sessions. `skill install|uninstall|refresh` puts the interviewer skill in `~/.agents/skills` and links it into the chosen agents; `update` reinstalls the CLI from the site.
