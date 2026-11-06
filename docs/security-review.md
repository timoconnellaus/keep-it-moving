# Security, abuse and cost review

Reviewed on 29 October 2026, on the `security-cost-audit` branch, against `src/worker`, `src/server`, `wrangler.jsonc` and the web client's rendering. The threat model: the site is open to anyone with a Google account and the source is public, so assume a stranger who has read the code, holds one or more Google accounts, and can script requests.

Prices are from Cloudflare's docs as of this review ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), updated 2 October 2026; [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/); [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)).

## Summary

Isolation between users is sound: no route lets one user reach another's hub, interview, artifacts, chat or share, except through assignment as designed. The serious problems were an open redirect, artifacts usable as phishing pages on the site's own domain, and cost. The cost problem was that a signed-in stranger could drive requests, Durable Object (DO) row writes and KV writes with no per-user limit.

This branch fixes those and five smaller issues in seven commits. What remains is mostly cost:

- A single account at the new per-user request ceiling can still cost roughly **$290 a month**, most of it DO row writes.
- Anyone can open more accounts.

The next steps are a write limit, a billing alert and slowing account creation. They're judgement calls, so they're written up below, not built.

## Findings

Ranked by severity. "Fixed" names the commit on this branch.

### High

**1. Open redirect after sign-in.** Fixed in `ac84e3b`.
`safeNext` refused `//host` and `/\host`, but `/<tab>/evil.example` passed: browsers strip tabs and newlines from URLs, so it became `//evil.example`. Both redirect paths were affected: `/auth/google/callback` (via the flow cookie) and `/signin?next=` when already signed in. A link like `https://keep-it-moving.zerobsai.com/signin?next=/%09/evil.example` sent a signed-in user to evil.example, which made it a credible phishing hop. `safeNext` now resolves `next` the way a browser does and keeps only a same-origin path, query and hash. A test covers tab, newline and backslash variants.

**2. HTML artifacts could be opened as full pages on the site's domain.** Fixed in `c465c3e`. A residual risk remains.
A mockup is arbitrary HTML that runs scripts. Its view URL was sandboxed (opaque origin, so no cookies and no API access) but it rendered as a whole top-level page at `keep-it-moving.zerobsai.com/...`. A stranger could build a fake Google sign-in as a mockup, assign the interview to the victim's email and send them the view URL. The victim signs in for real, then lands on a page at our domain that asks for a password and `fetch`es it to the attacker (the sandbox allows scripts and doesn't stop cross-origin requests). The view now refuses `Sec-Fetch-Dest: document` with a 403, and `frame-ancestors 'self'` stops other sites framing it. The page only ever loads it in an iframe, so nothing in the app changes.
_Residual:_ inside the interview page the frame still shows the attacker's HTML. It's labelled as their interview and "From <name>", but a convincing fake form in a frame is still possible. **Recommendation:** serve artifact views from a separate origin with no cookies, such as `kim-usercontent.zerobsai.com`, as GitHub and Google do. That removes the "our domain" trust entirely. It costs a second custom-domain route on the same Worker plus a signed, expiring view URL, since the cookie won't travel there. Medium effort, no running cost.

**3. No per-user request limit, so one account could run up the bill.** Mostly fixed in `71b645b`. The residual risk is item 4.
Only `/register` and Google sign-in were rate-limited. Every authenticated route (the hub's whole API, sockets, `/api/browser/shared`) was unlimited, so a script with one account's cookie or token could drive Worker requests, DO requests, DO rows written and KV operations as fast as it could send them. Now:

- `API_LIMITER` is a new Rate Limiting binding: 1,200 requests a minute per user (by email). It covers everything a signed-in browser, CLI or agent key sends to a hub, including assignees' requests into an owner's hub. It sits well above a few tabs, which get at most one overview refetch per 300 ms each, plus an agent.
- `AUTH_LIMITER` also covers `/token` and `/authorize` per IP. Keyed by user (`write:<email>`), it also covers assigning and making keys, at 20 a minute: those write KV, at $5 a million.
- The Rate Limiting binding has no listed price. Its counts are approximate and kept per Cloudflare location, so a client spread over many locations gets more.

### Medium

**4. Residual cost: DO row writes at the per-user ceiling, and accounts are free to make.** Not fixed: a judgement call.
Each write request (an answer, a chat message, an artifact edit) writes about four rows: the event, its index entry, the answer or message row, and sometimes an alarm. At 1,200 a minute that's about 200 million rows a month, or ~$200 for one account (see the estimate below). Sign-up is open to any Google account, and the per-IP sign-in limit doesn't stop someone with several accounts. Recommendations, cheapest first:

- **Turn on billing notifications** for Workers and Durable Objects usage in the Cloudflare dashboard. It's free, and it's the only control here that catches what nothing else does. Account setting.
- **Add a per-user write limit**, such as 300 non-GET requests a minute, on a third `ratelimits` binding. "Accept N defaults" posts one answer per question (up to 200), so 300 still covers it. That brings the worst case per account from ~$290 to ~$85. It's a product limit, so I didn't set it.
- **Slow account creation**: Turnstile on `/signin` (free, one widget and a server-side check in `googleCallback`), or an approval or waitlist step for new emails (the `user:` KV records the admin page lists are most of that already). Either one is a product decision.
- For a global rather than per-location limit, Cloudflare WAF rate-limiting rules. Paid tiers only.
- The planned plans (a Free tier with a few live interviews) would bound this too. Put the free tier's caps on writes and storage, not just interview counts.

**5. A workspace can grow to the DO's 10 GB cap.** Not fixed: needs a product limit and a deploy-time check.
The caps on interviews, questions, artifacts and chat bound the _number_ of rows, not their size, and some tables have no cap. Per workspace:

- Artifacts: 500 interviews × 50 artifacts × 1.9 MB is about 47 GB.
- Events: unbounded. Every answer revision stores the answer, up to 100 KB, in the event payload too, so revising one answer 100,000 times writes 10 GB.

So the real ceiling is the platform's 10 GB per object. A filled workspace costs $2 a month for as long as it's kept (stored data is $0.20/GB-month past 5 GB-month account-wide). Filling it takes only about 5,000 large writes. Across many accounts it adds up, and it never goes away by itself.

**Recommendation:** a byte budget per workspace, such as 1 GB. I didn't build it on `ctx.storage.sql.databaseSize` because Cloudflare's docs don't say whether that shrinks after deletes. If it doesn't, a full workspace could never get back under the cap, even after deleting interviews. The robust form is a small `usage` table, initialised once from `SUM(length(...))`:

- Each write adds the bytes it stores (and an update subtracts the old value).
- `deleteSession` subtracts that interview's total.
- Writes that would cross the budget fail with `Limit reached`, like the other caps.

Also consider capping events per interview, such as 20,000, so a single interview's history stays readable.

**6. Artifacts over 2 MB couldn't actually be stored.** Fixed in `89d8712`.
The schema allowed 4 MB of content plus 4 MB of source, but a DO SQLite row holds at most 2 MB, so a large mockup failed with SQLite's own error. Content and source together are now held to 1.9 MB in UTF-8 bytes, with a clear `Limit reached` message on add and update. (An archify diagram is about 700 KB, so normal use is unaffected.) This also halves the per-artifact storage worst case.

**7. Made-up agent keys hit the owner's hub on every request.** Fixed in `71b645b` and `a3f17f1`.
A `kim_…` bearer with no `agent-key:` owner record in KV fell back to `OWNER_EMAIL`'s hub to be verified. That way keys from before owners were recorded keep working. So anyone could send unlimited guesses, each one a KV read plus a request to the owner's DO. The owner's DO has a soft limit of 1,000 requests a second, so this could also deny the owner service. Now:

- Fallback lookups are limited per IP (`key:<ip>` on `AUTH_LIMITER`) before reaching the hub.
- An owner's legacy key gets its owner record on first successful use, so it never takes the limited path again. This only adds KV entries; nothing is migrated or deleted.
- Key-owner lookups are cached for five minutes per isolate. The hub still verifies the key, revoked or not, on every request.

**8. Assignment is an unsolicited channel into anyone's home page.** Not fixed: a product decision.
Anyone can assign an interview to any email. It then appears under that person's **Shared with you** with a title of up to 200 characters chosen by the sender. "From" shows the sender's Google display name, which they can set to anything ("Google Security"). Nothing is emailed, so the reach is limited to people who sign in, but it's a spam and phishing surface, and the new per-user KV write limit (20 a minute) only slows it. Recommendations:

- Show the sender's email next to their name in the list and on the interview. Small change to `recordAssignment` metadata and `Home.tsx`.
- Let the assignee dismiss or block a sender.
- Optionally, only list interviews from senders the assignee has interacted with before. That changes how sharing works, so it's a product call.

**9. Push notifications fanned out to an unbounded list of devices.** Fixed in `2d0527a`.
Subscriptions were already limited to real push services (so no SSRF), but neither how many there were nor the endpoint length was capped. Each "Send a test" or notification sent one outbound request per device. Now the 20 newest devices are kept (re-subscribing moves a device to the front, so a reinstalled phone is never locked out), and endpoints over 2,000 characters are refused.

### Low

**10. Agent keys and browser sockets were unbounded.** Fixed in `2d0527a`.

- Agent keys: each one writes a KV owner record, and revoked keys keep their rows. Now 50 live keys and 500 ever made per workspace.
- Browser sockets: one DO could accept any number of sockets, and every event fans out to them. Now 50 per page and viewer (each interview, and the list), 1,000 per workspace, answered with 429 beyond that. The page's socket client already backs off. This one runs in the DO class, which the Node test harness can't load, so it's checked by typecheck only.

**11. The older CLIs' HTTP waits keep a Durable Object awake.** Not fixed: removing them would break old CLIs.
`GET /api/sessions/:id/wait` (up to an hour), `/attach` (a stream with a heartbeat every 25 s and no end) and `/events/next` hold the DO in memory, so it's billed for duration. The current CLI only uses the hibernating socket (`/socket`), so these exist only for older CLIs. One workspace with an open `attach` is awake all month: 128 MB × 2.6 M s is about 324,000 GB-s, roughly $4. **Recommendation:** after a notice period (`kim` already tells users when a newer CLI is out), return 410 from those three routes. Meanwhile they're under `API_LIMITER` like everything else.

**12. State broadcasts carry every Markdown and SVG artifact in full.** Not fixed.
`forBrowser` strips HTML artifacts from the state message but not Markdown documents or SVG diagrams. Every event re-sends the whole interview state to every page socket, including up to 50 documents of up to 1.9 MB each. Sending is free, but building that message costs DO time on every event, and very large messages may fail. **Recommendation:** load non-plan documents and SVGs by URL like HTML artifacts, or send only the artifact that changed.

**13. The VAPID subject carries `OWNER_EMAIL` to push services.** Not fixed: trivial, but it's the operator's contact choice.
`push.ts` signs every push with `sub: mailto:<OWNER_EMAIL>`. The endpoints are limited to Google, Mozilla, Microsoft and Apple's push services, so no stranger receives it, but the README treats `OWNER_EMAIL` as a secret. Using `PUBLIC_URL` (allowed by the VAPID spec) keeps it private.

**14. Session lifetime.** Not fixed: acceptable as is.
Sign-out deletes the KV session, but other isolates may honour their cached copy for up to 30 s. A browser session lasts 30 days from last use and isn't tied to the Google account's state, so a disabled Google account keeps working until then. There's no "sign out everywhere". For admins, deleting `session:*` keys for an email is the manual remedy. A reverse index from email to session ids would make it one call.

**15. OAuth access tokens are checked against KV on every agent request.** Not fixed: inside `@cloudflare/workers-oauth-provider`.
That's one KV read ($0.50 a million) per CLI request, now bounded by `API_LIMITER`. Browser requests don't do this: sessions and shares are cached.

**16. Unhandled "Session not found" from a timer.** Fixed in `e93e381`.
`wake()` reviewed every agent socket and read its interview. If the interview had gone and its socket was still listed, which is what the Worker test's teardown produced, the timer threw. `review()` now ends such a socket with 4404 and a `deleted` message, as the delete route does. A new test deletes an interview behind a waiting socket's back.

## Checked and sound

- **Isolation.** `hubFor` derives the DO from the signed-in email (`user:<email>`, or the owner's `interviews`). There's no path from one user's request to another's hub except the share route.
- **Shares.** The share route sends a request to the owner's hub only when the share's assignee is the signed-in user. The hub then re-checks the assignee on every request and socket (`respondentMayUse`) and allows only the interview's page routes.
- **Worker-only headers.** `x-kim-respondent`, `x-kim-via-key` and `x-kim-assigned-by` are stripped from every client request before being set. `/internal/*` (key verification) has no public route.
- **Agent keys.** `KEY_ALLOWED` is an allowlist, and `/api/sessions/kim/*` never falls through to `:id`. Keys can't answer, delete or manage keys.
- **Keys can read and share answers.** A key can read every interview's answers and chat (`GET /api/sessions/:id`) and assign interviews, which shares them with any email. That's the documented scope, but it means a leaked key exposes the whole workspace's content. Worth saying in the README's agent-keys section.
- **OAuth.** `/authorize` completes only for `http://` loopback redirect URIs, so a code can't be collected off-machine. Client registration and the token swap are rate-limited per IP. Google sign-in checks PKCE, state, nonce, issuer, audience and `email_verified`.
- **CSRF.** Browser writes need `Sec-Fetch-Site: same-origin` (or a same-host `Origin`). Page WebSockets are checked the same way in the DO. Sign-out is a POST with the same check. Cookies are `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`.
- **XSS.**
  - The Worker's own pages escape every interpolated value (`escapeHtml`), and the admin page escapes names and emails.
  - The web client renders Markdown with `react-markdown`, without raw HTML, so it drops `javascript:` links.
  - SVG diagrams render as `<img>`, so their scripts don't run.
  - HTML artifacts are sandboxed by CSP (item 2).
- **Admin.** `/admin` returns 404 unless the email is in `ADMIN_EMAILS`. It costs one KV list per 1,000 users per load.

## Worst-case monthly cost

The assumptions:

- One abusive account sends requests from one Cloudflare location at the new `API_LIMITER` ceiling (1,200 a minute = 20 a second), all month: 51.8 M requests.
- It uses an agent key (the most expensive path: a KV read for the OAuth/key check and a second DO request to verify the key).
- Every request is a write of about four rows.
- It also assigns at the per-user KV write limit (20 a minute, about three KV operations each) and fills its workspace to the 10 GB DO cap.

Included allowances are account-wide and already used by normal traffic, so they're left out: these are marginal costs.

| Item                                  | Volume a month | Price            | Cost       |
| ------------------------------------- | -------------- | ---------------- | ---------- |
| Worker requests                       | 51.8 M         | $0.30 / M        | $15.55     |
| Worker CPU (≈3 ms each)               | 155 M ms       | $0.02 / M ms     | $3.11      |
| DO requests (hub + key verify)        | 103.7 M        | $0.15 / M        | $15.55     |
| DO duration (awake all month, 128 MB) | 324,000 GB-s   | $12.50 / M GB-s  | $4.05      |
| DO rows written (≈4 per write)        | 207 M          | $1.00 / M        | $207.36    |
| DO rows read (≈2,000 per state build) | ~100 B         | $0.001 / M       | ~$0.10     |
| KV reads (OAuth token check)          | 51.8 M         | $0.50 / M        | $25.92     |
| KV writes and deletes (assigning)     | 2.6 M          | $5.00 / M        | $12.96     |
| DO stored data (one full workspace)   | 10 GB-month    | $0.20 / GB-month | $2.00      |
| **Per abusive account**               |                |                  | **≈ $286** |

- **With a 300-a-minute write limit (item 4):** rows written fall to about $52, and the account totals about **$85**.
- **N accounts, or one account spread across N Cloudflare locations,** cost N times as much: the rate limiter counts per location. Ten accounts at the ceiling is about $2,900 a month.
- **Normal use:** a handful of people with their agents fits inside the $5 Workers Paid minimum and its allowances (10 M requests, 1 M DO requests, 50 M rows written, 1 M KV writes, 5 GB-month stored).
- **Before this branch:** there was no per-user limit, so an account's cost was bounded only by how fast it could send requests. The DO's soft limit of 1,000 requests a second per object put the rough ceiling at 50 times the table above.

## Deploying this branch

- `wrangler.jsonc` adds the `API_LIMITER` binding (namespace 1002). Nothing needs setting up in the dashboard, and the installed Wrangler (4.146) is past the 4.36 the binding needs.
- No secrets changed and nothing is migrated. The first use of each pre-records owner key writes one `agent-key:` KV record.
- If Workers Logs show 429s for real users, raise `API_LIMITER`'s limit in `wrangler.jsonc`. Nothing else depends on the number.

## Addendum, 6 November 2026: end-to-end encryption

Interviews of accounts that turn encryption on are now end-to-end encrypted (see the README's "End-to-end encryption"). What that changes here:

- **The service can't read encrypted interviews.** A leaked Durable Object, KV namespace or log holds ciphertext for them, and metadata: emails, timestamps, counts, sizes, question types and the project's repo. Plain interviews (older ones, and accounts that haven't turned it on) are as before.
- **Finding 2's residual risk is gone for encrypted interviews.** Their HTML artifacts have no URL on this domain: the page frames them with `srcdoc` and `sandbox="allow-scripts"`, so they still run in an opaque origin, and a `no-referrer` meta keeps the page's URL out of what they load.
- **Screenshots** render on the agent's machine (`kim inbox screenshot`), so Browser Run, its R2 bucket and its budget are gone, along with their cost.
- **New trust in the client.** The web app is served by this Worker, so a malicious deploy could take keys from browsers. The public-key directory isn't verified either: a compromised service could list its own key for an assignee before the owner's client grants them access. Both are outside what this encryption protects against, and the README says so.
- **New routes.** Grants (`…/grant`, `…/grants`) and the account key (`/api/browser/account/*`) are scoped like the rest: a grant is useless without its recipient's private key, assignees can read only their interview's grant, and only owners' clients add grants. Agent keys may read `kim/account`, `kim/pubkeys` and `kim/grants`, since a cloud environment holds the content key anyway.
