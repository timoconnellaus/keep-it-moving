import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { InterviewHub } from "./hub.js";

export interface Env {
  HUB: DurableObjectNamespace<InterviewHub>;
  /** OAuth grants, browser sessions, and which user each agent key belongs to. */
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ASSETS: Fetcher;
  /** The public origin, e.g. https://keep-it-moving.zerobsai.com. */
  PUBLIC_URL: string;
  /**
   * The deployment's owner, whose workspace predates multi-user. A secret, so
   * it isn't in the repo; without it, every user gets a `user:` workspace.
   */
  OWNER_EMAIL?: string;
  /** The Google OAuth client the browser signs in with. A secret, like its secret. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Web Push (VAPID): the public key as base64url, the private key a JWK secret. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  /**
   * Limits sign-in, client registration and the token swap per IP, and KV
   * writes per user; see wrangler.jsonc.
   */
  AUTH_LIMITER?: RateLimit;
  /** Limits every signed-in user's requests, per user; see wrangler.jsonc. */
  API_LIMITER?: RateLimit;
  /** Comma-separated emails that may open /admin. A secret; without it, nobody can. */
  ADMIN_EMAILS?: string;
  /**
   * Stripe billing for Pro, all secrets. Without them, upgrading says Pro is
   * coming soon and nothing calls Stripe.
   */
  STRIPE_SECRET_KEY?: string;
  /** The webhook endpoint's signing secret (whsec_…). */
  STRIPE_WEBHOOK_SECRET?: string;
  /** The recurring Price for Pro, $5 a month (price_…). */
  STRIPE_PRICE_PRO?: string;
  /** Local development only: skips Google and signs in as this address on localhost. */
  DEV_EMAIL?: string;
}
