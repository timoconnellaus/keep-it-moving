# Marketing page: system designs and the repo

**Goal:** tell visitors that Keep it moving now plans software properly, and that the result lands in their repo, without losing the page's simple promise ("your agent asks, you answer in one click").

## What's new to sell

- **System designs:** data model, architecture, data flow, sequence, state machine and API contract, beside the questions.
- **Compare with main:** changes are highlighted against the repo copy.
- **It lands in your repo:** kept designs, a rendered SVG of each, and the plan go to `.kim/` for the PR.
- **Optional design system:** mockups draw with your tokens.

## Decisions

- **A new section** between Features and How it works, headlined *Design it in the interview. Ship it in the PR.* It has four steps beside an illustration of the System tab and the PR's files.
- **The hero stays**, with one new line under the subhead about designs and the plan landing in the repo.
- **Elsewhere on the page:** Free's pricing lists "System designs and repo sync", *How it works* gets a final "Writes it back" step, and the Diagrams and mockups card mentions data models and APIs.
- **The design system gets its own section** after the first, headlined *Your design system, in every mockup*, with an *Optional* pill. It shows a tokens card with one changed swatch and the chat that changed it, beside three mockups marked updated, and a tile saying mockups bring their own styles without one.
- **Re-record the hero demo now**, with a schema step in the checkout story.

## Next steps

1. Edit `docs/marketing/keep-it-moving.html`: the hero line, both new sections, the feature card, How it works and pricing.
2. Re-record the demo with a schema step (`docs/marketing/demo/`: story, capture, build).
3. Rebuild the landing page and deploy.
