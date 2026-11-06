# Checkout rework

## Decided

- Stripe Checkout, hosted by Stripe
- Guest checkout on; `orders.email` holds a guest's address
- One-page checkout, order summary on the right
- A `payments` row per Stripe Checkout session; the webhook sets its status
- Stripe Tax at checkout, Stripe's receipt emails, refunds from the dashboard

## Next

- Migration: `payments`, `orders.email`, optional `orders.user_id`
- Build the one-page form behind a flag
- Handle `checkout.session.completed` in the webhook
