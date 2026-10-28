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
  /** Limits sign-in and client registration per IP; see wrangler.jsonc. */
  AUTH_LIMITER?: RateLimit;
  /** Local development only: skips Google and signs in as this address on localhost. */
  DEV_EMAIL?: string;
}
