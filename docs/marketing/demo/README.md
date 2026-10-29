# The marketing page and its product demo

`../keep-it-moving.html` is the marketing page, and the one source for it. It's published as the "Keep it moving" artifact, and `npm run build:web` wraps it into `web-dist/landing.html` (`scripts/build-landing.mjs`): a document, viewport, description and favicon, and the install command naming the deployment that serves it. The Worker serves that page at `/` to signed-out visitors; signed in, `/` is the app. Links to the site in it are relative (`/signin`, `/pricing`), so a self-hosted copy points at itself.

Edit the page by hand, except for its two demo scripts, which `build.mjs` writes. The hero demo is the real app, not a drawing. The app was captured from a local run, and the page replays it.

- `capture.mjs` drives a fresh "Checkout rework" interview through the demo's story. The user's side is clicks in headless Chrome. The agent's side is `kim` calls: plans `plan-1..3.md`, mockups `layout-a/b.html`, questions, chat and stop. At each of nine steps it saves the page's `.shell` DOM to `states.json`.
- `build.mjs` replaces the page's `#demo-doc` script with an iframe document. That document holds the captured states, with mockups as `srcdoc`, and the built app CSS from `web-dist/assets/*.css`, with `.demo-hover`/`.demo-focus` twins of its `:hover`/`:focus` rules. It also replaces the player script after the morphdom tag with `player.js`.
- `player.js` scales the 1440×860 app to the frame and rounds the frame's corners in proportion. It moves between the states with morphdom, adds the cursor and typing, and highlights each plan revision's new lines. It plays only on screen, and shows a still frame for reduced motion.

To refresh it after an app change:

1. `npm run build`, then `npx wrangler dev --local --host localhost --port 8787` (with `.dev.vars` as in the main README).
2. `KIM_HOME=<a HOME with kim signed in to localhost> node docs/marketing/demo/capture.mjs`. It deletes every interview in that local account first.
3. `node docs/marketing/demo/build.mjs`, then `npm run build:web` (or `node scripts/build-landing.mjs`) for the landing page.
4. Republish `docs/marketing/keep-it-moving.html` to the artifact.
