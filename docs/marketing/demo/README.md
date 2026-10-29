# The marketing page's product demo

`../keep-it-moving.html` is the marketing page (published as the "Keep it moving" artifact). Its hero demo is the real app, not a drawing. The app was captured from a local run, and the page replays it.

- `capture.mjs` drives a fresh "Checkout rework" interview through the demo's story. The user's side is clicks in headless Chrome. The agent's side is `kim` calls: plans `plan-1..3.md`, mockups `layout-a/b.html`, questions, chat and stop. At each of nine steps it saves the page's `.shell` DOM to `states.json`.
- `build.mjs` takes `base.html` (the page before the demo) and does three things:
  - removes the hero tiles and adds the grid;
  - inlines the built app CSS from `web-dist/assets/*.css`, adding `.demo-hover`/`.demo-focus` twins of its `:hover`/`:focus` rules;
  - puts the captured states into an iframe document, with mockups as `srcdoc`.
- `player.js` is the page's script. It moves between the states with morphdom, adds the cursor and typing, and highlights each plan revision's new lines. It plays only on screen, and shows a still frame for reduced motion.

To refresh it after an app change:

1. `npm run build`, then `npx wrangler dev --local --host localhost --port 8787` (with `.dev.vars` as in the main README).
2. `KIM_HOME=<a HOME with kim signed in to localhost> node docs/marketing/demo/capture.mjs`. It deletes every interview in that local account first.
3. `node docs/marketing/demo/build.mjs`.
4. Republish `docs/marketing/keep-it-moving.html` to the artifact.
