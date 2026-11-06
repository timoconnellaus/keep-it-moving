# Marketing page: system designs and the repo

**Goal:** tell visitors that Keep it moving now plans software properly, and that the result lands in their repo, without losing the page's simple promise ("your agent asks, you answer in one click").

## What's new to sell

- **System designs:** data model, architecture, data flow, sequence, state machine and API contract, beside the questions.
- **Compare with main:** changes are highlighted against the repo copy.
- **It lands in your repo:** kept designs, a rendered SVG of each, and the plan go to `.kim/` for the PR.
- **Optional design system:** mockups draw with your tokens.

## Decisions

- **A new section** between Features and How it works, headlined *Design it in the interview. Ship it in the PR.* It has four steps beside an illustration of the System tab and the PR's files.
- **The hero gets five tabbed demos**, as on os.cloudflare.app: 01 Answer, 02 Design, 03 Mock up, 04 Ship, 05 Share. Each tab is numbered, with a caption and a progress bar that fills while its demo plays, and the current one is highlighted. Each demo is a replay of the real app. The hero copy stays, with no extra subhead line.
- **Elsewhere on the page:** Free's pricing lists "System designs and repo sync", *How it works* gets a final "Writes it back" step, and the Diagrams and mockups card mentions data models and APIs.
- **The design system gets its own section** after the first, headlined *Your design system, in every mockup*, with an *Optional* pill. It shows a tokens card with one changed swatch and the chat that changed it, beside three mockups marked updated, and a tile saying mockups bring their own styles without one.
- **Open source, clearly:** the CLI and the skill are MIT, and the Worker and web app AGPL-3.0 (previously FSL-1.1-MIT). The page has a GitHub button with the star count in the nav and the hero (the count shows once there's at least one star), a "Self-host it free, forever" line, and an open source section after Features.

## Next steps

1. ~~Both new sections, the feature card, How it works, pricing, the open source treatment and the licence~~ (shipped).
2. Capture the five demos and build the tabbed hero (`docs/marketing/demo/`).
3. Rebuild the landing page and deploy.
