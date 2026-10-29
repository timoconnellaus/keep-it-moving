import type { PlanRecord, PlanSource, PlanView } from "./plans.js";
import type { UserRecord } from "./users.js";

export const REPO_URL = "https://github.com/timoconnellaus/keep-it-moving";

/** The brand mark; its top bar follows the text colour, for dark mode. */
const LOGO = `<svg class="logo" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="13" height="5" rx="2.5" fill="currentColor"/><rect x="2" y="10" width="20" height="5" rx="2.5" fill="#1f6bff"/><rect x="2" y="17" width="9" height="5" rx="2.5" fill="#ffd23f"/></svg>`;

/**
 * The Worker's own pages (sign-in, errors, plans, admin) in the app's brand
 * (docs/design/reference.html). Light only, like the app.
 */
const shell = (body: string, className = "") => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Keep it moving</title>
<link rel="icon" href="/icons/icon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Figtree:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
  :root {
    --ground: #e8eaed; --panel: #f6f6f7; --card: #fff; --ink: #0e0f11;
    --muted: #676c74; --line: #e4e6ea; --blue: #1f6bff; --blue-soft: #e8f0ff;
    --yellow: #ffd23f; --night: #0b0b0c; --night-card: #19191c;
    --night-line: #2b2b30; --night-muted: #a3a6ad;
    --display: "Outfit", "Avenir Next", ui-sans-serif, system-ui, sans-serif;
    --body: "Figtree", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    grid-template-columns: minmax(0, 1fr);
    padding: 16px; background: var(--ground); color: var(--ink);
    font: 16px/1.6 var(--body); -webkit-font-smoothing: antialiased;
  }
  main {
    width: min(480px, 100%); padding: clamp(28px, 6vw, 44px) clamp(20px, 5vw, 40px);
    border: 1px solid var(--line); border-radius: 28px; background: var(--panel);
    text-align: center;
  }
  .brand {
    display: inline-flex; align-items: center; gap: 8px; color: var(--ink);
    font: 700 18px var(--display); letter-spacing: -0.02em; text-decoration: none;
  }
  h1, h2 { font-family: var(--display); letter-spacing: -0.025em; text-wrap: balance; }
  h1 { margin: 22px 0 8px; font-size: clamp(30px, 6vw, 40px); font-weight: 600; line-height: 1.08; }
  p { margin: 0 0 24px; color: var(--muted); }
  .lead {
    margin: 26px 0 20px; color: var(--ink); font: 500 clamp(20px, 4vw, 24px)/1.35 var(--display);
    letter-spacing: -0.015em; text-wrap: balance;
  }
  .lead + form, .lead + p { margin-top: 0; }
  a { color: var(--blue); }
  code { font-family: var(--mono); font-size: 0.9em; }
  :focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; border-radius: 8px; }
  .google, .plan .action, .plan button {
    display: inline-flex; align-items: center; justify-content: center; gap: 10px;
    padding: 12px 20px; border: 0; border-radius: 10px;
    font: 600 15px var(--body); text-decoration: none; cursor: pointer;
  }
  .google { background: var(--ink); color: var(--card); }
  .google svg { background: #fff; border-radius: 50%; padding: 3px; box-sizing: content-box; }
  .google:hover { opacity: 0.88; }
  form { margin: 0 0 16px; }
  main.wide { width: min(1040px, 100%); text-align: left; }
  .wide h1 { margin-top: 18px; }
  .plans {
    display: grid; gap: 16px; margin: 8px 0 24px; padding: clamp(16px, 3vw, 28px);
    border-radius: 22px; background: var(--night); color: #fff;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  }
  .plan {
    display: flex; flex-direction: column; gap: 14px; padding: 24px;
    border: 1px solid var(--night-line); border-radius: 18px; background: var(--night-card);
  }
  .plan.current { border-color: var(--blue); box-shadow: 0 0 0 3px #1f6bff40; }
  .plan h2 {
    align-self: flex-start; margin: 0; padding: 4px 12px; border-radius: 999px;
    border: 1px solid var(--night-line); background: #0f0f11;
    font: 600 13px var(--body); letter-spacing: 0;
  }
  .plan.current h2 { background: var(--yellow); border-color: var(--yellow); color: #0e0f11; }
  .plan .price { margin: 0; color: #fff; font: 600 44px/1 var(--display); letter-spacing: -0.03em; }
  .plan .price small { color: #d4d6db; font: 500 18px var(--display); letter-spacing: 0; }
  .plan ul { flex: 1; margin: 0; padding: 14px 0 0; border-top: 1px solid var(--night-line); list-style: none; color: #e6e7ea; font-size: 15px; }
  .plan li { position: relative; padding-left: 26px; }
  .plan li::before {
    content: ""; position: absolute; left: 0; top: 5px; width: 15px; height: 15px;
    border: 1px solid #6f737b; border-radius: 50%;
  }
  .plan li::after {
    content: ""; position: absolute; left: 5px; top: 8px; width: 4px; height: 7px;
    border: solid #e6e7ea; border-width: 0 1.5px 1.5px 0; transform: rotate(45deg);
  }
  .plan li + li { margin-top: 8px; }
  .plan form { margin: 0; }
  .plan .action, .plan button { width: 100%; background: var(--blue); color: #fff; box-shadow: 0 8px 20px -8px #1f6bff99; }
  .plan .action:hover, .plan button:hover { background: #135cf0; }
  .plan .note { margin: 0; color: var(--night-muted); font-size: 14px; }
  .notice {
    padding: 10px 14px; border-radius: 12px; background: var(--yellow);
    color: #0e0f11; font-weight: 500;
  }
  td form { display: flex; gap: 6px; margin: 0; }
  td button, .setup button {
    padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px;
    background: var(--card); color: var(--ink); font: 600 13px var(--body); cursor: pointer;
  }
  .setup button { border-color: var(--blue); background: var(--blue); color: #fff; }
  .setup input {
    padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px;
    background: var(--card); color: var(--ink); font: 14px var(--body);
  }
  .table { overflow-x: auto; border: 1px solid var(--line); border-radius: 16px; background: var(--card); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 10px 14px; border-bottom: 1px solid var(--line); text-align: left; }
  tr:last-child td { border-bottom: 0; }
  th { color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
  td.when { white-space: nowrap; color: var(--muted); font-variant-numeric: tabular-nums; }
  .setup {
    margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--line);
    text-align: left;
  }
  .setup h2 { margin: 0 0 6px; font-size: 20px; font-weight: 600; }
  .setup p { margin: 0 0 12px; font-size: 15px; }
  .setup pre + p { margin-top: 12px; }
  .setup p:last-child { margin-bottom: 0; }
  .setup pre {
    margin: 0; padding: 14px 16px; border-radius: 14px;
    white-space: pre-wrap; overflow-wrap: anywhere;
    background: var(--night); color: #e6e7ea; border: 1px solid var(--night-line);
    font: 13px/1.9 var(--mono);
  }
</style>
<main class="${className}">
<a class="brand" href="/">${LOGO}Keep it moving</a>
${body}
</main>
</html>`;

export const page = (status: number, message: string) =>
  new Response(shell(`<p class="lead">${message}</p>`), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/**
 * Signed out: one button, which comes back to `next` afterwards, and how to
 * set up the CLI and skill, since agents start the interviews.
 */
export const signInPage = (next: string, origin: string) =>
  new Response(
    shell(`<h1>Sign in</h1>
<p>Sign in to see your interviews.</p>
<a class="google" href="/auth/google/start?next=${encodeURIComponent(next)}">
<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
Sign in with Google</a>
<section class="setup" aria-label="Set up the CLI and skill">
<h2>Interviews start from your agent</h2>
<p>Install the <code>kim</code> CLI and the interviewer skill, then sign in from the terminal:</p>
<pre>npm install -g ${escapeHtml(origin)}/cli.tgz
kim skill install
kim login</pre>
<p><code>kim skill install</code> asks which agents get the skill: Claude Code, Codex, Cursor, Gemini CLI, Copilot, OpenCode and more. Then ask your agent to interview you about something, such as “interview me about this feature”.</p>
<p>Free runs three live interviews at once; Pro, $5 a month, has no limit and assigns interviews to other people. <a href="/pricing">See the plans</a>.</p>
<p>Or run your own: the source is available at <a href="${REPO_URL}">github.com/timoconnellaus/keep-it-moving</a>, with how to deploy it to your Cloudflare account.</p>
</section>`),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const day = (ms?: number) =>
  ms === undefined ? "—" : new Date(ms).toISOString().slice(0, 10);

/** One person's plan on /admin. */
export interface AdminPlan {
  plan: PlanView["plan"];
  source: PlanSource;
  record: PlanRecord | null;
}

const planLabel = ({ plan, source, record }: AdminPlan) => {
  if (plan === "free")
    return record?.status ? `Free (Stripe: ${record.status})` : "Free";
  if (source === "stripe")
    return `Pro (Stripe: ${record?.status ?? "active"}${record?.currentPeriodEnd ? `, to ${day(record.currentPeriodEnd)}` : ""})`;
  return `Pro (${source})`;
};

/** Grant Pro by hand, or take the grant back: a same-site form post. */
const compForm = (email: string, { record }: AdminPlan) =>
  `<form method="post" action="/admin/plan"><input type="hidden" name="email" value="${escapeHtml(email)}">${
    record?.comp
      ? `<input type="hidden" name="plan" value="none"><button type="submit">End comp</button>`
      : `<input type="hidden" name="plan" value="pro"><button type="submit">Comp Pro</button>`
  }</form>`;

/** Who has signed up, and on which plan, for ADMIN_EMAILS only. */
export const adminPage = (
  users: UserRecord[],
  planFor: (email: string) => AdminPlan,
) =>
  new Response(
    shell(
      `<h1>Signed up</h1>
<p>${users.length} ${users.length === 1 ? "person" : "people"}. “Last seen” is accurate to a day; people who signed in before 29 October 2026 have no dates until they come back. A comp is Pro until it's ended, whatever Stripe says.</p>
<div class="table"><table>
<thead><tr><th>Email</th><th>Name</th><th>First seen</th><th>Last seen</th><th>Plan</th><th></th></tr></thead>
<tbody>
${users
  .map((user) => {
    const plan = planFor(user.email);
    const comp =
      plan.source === "owner" || plan.source === "admin"
        ? ""
        : compForm(user.email, plan);
    return `<tr><td>${escapeHtml(user.email)}</td><td>${escapeHtml(user.name ?? "")}</td><td class="when">${day(user.first)}</td><td class="when">${day(user.last)}</td><td>${escapeHtml(planLabel(plan))}</td><td>${comp}</td></tr>`;
  })
  .join("\n")}
</tbody></table></div>
<form method="post" action="/admin/plan" class="setup">
<h2>Comp someone who hasn't signed up yet</h2>
<p><input type="email" name="email" required placeholder="name@example.com"> <input type="hidden" name="plan" value="pro"><button type="submit">Comp Pro</button></p>
</form>`,
      "wide",
    ),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );

/**
 * The plans, public: Free, Pro and Team (coming soon), with what to do
 * next for whoever is looking, signed in or not.
 */
export const pricingPage = (
  viewer: PlanView | null,
  notice: string | null = null,
) => {
  const proAction = !viewer
    ? `<a class="action" href="/signin?next=%2Fpricing">Sign in to upgrade</a>`
    : viewer.plan === "pro"
      ? viewer.source === "stripe"
        ? `<form method="post" action="/billing/portal"><button type="submit">Manage billing</button></form>`
        : `<p class="note">You're on Pro.</p>`
      : viewer.billing
        ? `<form method="post" action="/billing/checkout"><button type="submit">Upgrade to Pro</button></form>`
        : `<p class="note">Pro is coming soon.</p>`;
  const card = (
    name: string,
    price: string,
    per: string,
    points: string[],
    action: string,
    current: boolean,
  ) => `<section class="plan${current ? " current" : ""}">
<h2>${name}${current ? " · your plan" : ""}</h2>
<p class="price">${price} <small>${per}</small></p>
<ul>${points.map((point) => `<li>${point}</li>`).join("")}</ul>
${action}
</section>`;
  return new Response(
    shell(
      `<h1>Plans</h1>
${notice ? `<p class="notice">${notice}</p>` : ""}
<p>Every plan has the questions, the chat, the living plan, diagrams and mockups. A live interview is one an agent is waiting on for answers; half-done ones nobody is waiting on don't count.</p>
<div class="plans">
${card(
  "Free",
  "$0",
  "",
  [
    "Up to 3 live interviews at once",
    "As many interviews as you like",
    "Answer interviews others assign to you",
  ],
  "",
  viewer?.plan === "free",
)}
${card(
  "Pro",
  "$5",
  "a month",
  [
    "No limit on live interviews",
    "Assign interviews to other people to answer",
    "Everything in Free",
  ],
  proAction,
  viewer?.plan === "pro",
)}
${card(
  "Team",
  "$5",
  "a user, a month",
  ["Shared workspaces for your team", "Everything in Pro, for everyone"],
  `<p class="note">Coming soon.</p>`,
  false,
)}
</div>
<p><a href="/">${viewer ? "Back to your interviews" : "Sign in"}</a></p>`,
      "wide",
    ),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
};
