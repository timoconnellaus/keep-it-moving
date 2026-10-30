# Billing: Free and Pro

What's built on the `billing-plans` branch, and what the owner has to do in Stripe before it takes money. Nothing calls Stripe until the three secrets are set; until then, upgrading says "Pro is coming soon".

## What's built

- **Plans.** Free: an agent waits on at most 3 active interviews at once, and no assigning. Pro, $5 a month: no limit, and assigning. Team ($5 a user a month) shows on `/pricing` as coming soon. `OWNER_EMAIL` and `ADMIN_EMAILS` are always Pro.
- **Enforcement in the hub** (`src/server/plans.ts`, one middleware in `src/server/hub.ts`). The Worker sets `x-kim-plan` on every request to a user's hub and strips any a client sends. On Free, a new watcher (the agent socket, or the older `wait`, `attach` and `events next`) or a hook's take (`POST /api/sessions/:id/take`) on an interview that isn't already live gets HTTP 402 `plan_limit` when 3 others are live, naming them and the upgrade URL; nobody already waiting is ended. An assign on Free gets the same 402 shape; clearing an assignment, an earlier assignment, and the assignee's answers keep working.
- **Plan record** (`src/worker/plans.ts`): `plan:<email>` in `OAUTH_KV`, with plan, Stripe status, customer and subscription ids, period end, cancel-at-period-end, seats (the subscription quantity, ready for Team) and an admin comp. Read through the 30-second isolate cache; the whole record is also the key's metadata, so `/admin` lists plans in one call.
- **Stripe** (`src/worker/stripe.ts`, fetch and Web Crypto, no SDK): `POST /billing/checkout` (Checkout, subscription mode, with the email in `client_reference_id` and the subscription's metadata), `POST /billing/portal` (Customer Portal), and `POST /stripe/webhook`: public, checks `Stripe-Signature` (HMAC-SHA256, 5-minute tolerance, any `v1`), applies each event once (`stripe-event:<id>` kept 30 days), ignores events older than the last one applied to that subscription, and never lets an old subscription's deletion touch a newer one. `stripe-customer:<id>` maps customers back to emails. It reads `current_period_end` from the subscription item (recent API versions) or the subscription (older ones).
- **UI.** The Account menu shows the plan, with **Upgrade to Pro** (or "Pro is coming soon"), **Manage billing** for subscribers, and **Compare plans**. On Free, the Assign button carries a Pro badge, and its menu says it's a Pro feature and links to the upgrade. `/pricing` is public and linked from the sign-in page. `/admin` has a Plan column with **Comp Pro** / **End comp** per person, and a form to comp an email that hasn't signed up yet (same-site POSTs to `/admin/plan`).
- **CLI and skill.** `kim` prints a `plan_limit` refusal on stderr with its `code`, `live` and `upgradeUrl`, and exits 1. A refused socket upgrade makes it ask the same route over HTTP why, instead of retrying forever. `session create --assign` says the interview was created without an assignee. The skill tells the agent to relay the refusal and suggest `kim session stop` or upgrading.
- **Tests**: `tests/plans.test.ts` covers 3 live allowed, the 4th refused, half-done not counted, existing watchers kept, takeover, a stopped interview freeing a place, Pro unlimited, assign gating and the spawned CLI's output. `tests/take.test.ts` covers hook takes counting as live, and refused like a socket. `tests/worker.test.ts` covers header stripping, the webhook's signatures, plan changes, idempotency and ordering, Checkout and Portal, `/pricing` and the admin comp.

## What the owner does in Stripe

Do it all in test mode first, then repeat in live mode.

1. **Create the account** and set the business details and payout bank account.
2. **Product and price:** Product catalogue → Add product "Keep it moving Pro", recurring, $5.00 USD monthly. Copy the price id (`price_…`). Team will be a second product, priced per seat, later.
3. **Customer Portal:** Settings → Billing → Customer portal. Allow updating payment methods, viewing invoices and cancelling at the end of the billing period. Save, which activates it; the portal won't open before that.
4. **Webhook:** Developers → Webhooks → Add endpoint `https://keep-it-moving.zerobsai.com/stripe/webhook`, with the events `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`. Copy the signing secret (`whsec_…`).
5. **Secrets** on the Worker:

   ```sh
   npx wrangler secret put STRIPE_SECRET_KEY      # sk_… (or a restricted key: write on Checkout Sessions and Customer portal, read on Customers and Subscriptions)
   npx wrangler secret put STRIPE_WEBHOOK_SECRET  # whsec_…
   npx wrangler secret put STRIPE_PRICE_PRO       # price_…
   ```

6. **Try it:** as a Free user, choose **Upgrade to Pro** in the Account menu and pay with the test card `4242 4242 4242 4242`. `/pricing?checkout=done` says Pro turns on once Stripe confirms; within a few seconds the Account menu says Pro and **Manage billing** opens the portal. Cancel there, and the menu shows when Pro ends. Stripe's dashboard shows each webhook delivery and its response.

## Worth knowing

- A plan change reaches the isolate that handled the webhook at once and the others within 30 seconds.
- KV is eventually consistent, so the "applied once" check is best-effort across data centres. Applying an event twice sets the same state, and the ordering check stops an older event undoing a newer one.
- Stripe statuses `active`, `trialing` and `past_due` count as Pro (past_due while Stripe retries the card). `unpaid`, `incomplete`, `canceled` and the rest are Free.
- A comp holds Pro whatever Stripe says, until an admin ends it.
- The live count includes the 5-second grace after a wait ends, so an agent chaining waits keeps its place.
- An interview is live too for 15 minutes after its hook last took answers (`sessions.hook_seen_at`), while it has questions open, so an agent working between waits keeps its place. Answering everything or stopping it frees the place at once.
