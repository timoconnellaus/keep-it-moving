# Keep it moving for Orca

Answer your agents' [Keep it moving](https://keep-it-moving.zerobsai.com) interviews without leaving Orca.

- **Interviews panel** in the right sidebar: the focused workspace's interview first, with its next question answered right there (choices, yes/no, numbers, short text, and choices between mockups, drawn live). Then interviews sent to you, with **Start an Agent** to draft your answers, and everything else.
- **Status bar**: shows up only when an interview needs you. Click it to open that interview.
- **Notifications** when an agent replies in the chat, someone sends you an interview, or an agent has been waiting on you for 10 minutes.

## Needs

`kim`, Keep it moving's CLI, installed and signed in (your agents use it too):

```sh
npm install -g https://keep-it-moving.zerobsai.com/cli.tgz
kim login
```

The plugin runs `kim` through your login shell and never connects to anything itself. If `kim` isn't on your shell's PATH, set its full path in the plugin's settings. **Open in browser** uses the `orca` CLI to open an Orca tab, and the default browser without it.

## Develop

```sh
orca plugin validate .
orca plugin dev load .     # Orca asks you to approve it
orca plugin logs local.keep-it-moving
```

Tests and the typecheck run from the Keep it moving repository (`npm test`, `npm run typecheck`).

Bundled: Tailwind CSS (MIT, `vendor/LICENSE.tailwindcss`), Lucide icons (ISC, `vendor/LICENSE.lucide`), and fonts from Fontsource under the SIL Open Font License (`kit/`).
