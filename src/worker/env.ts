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
  /** The deployment's owner: their workspace predates multi-user, and only theirs gets GITHUB_TOKEN. */
  OWNER_EMAIL: string;
  /** The Google OAuth client the browser signs in with; its secret is a secret. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Web Push (VAPID): the public key as base64url, the private key a JWK secret. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  /** GitHub API token (secret) for PRs, checks, diffs and issues. */
  GITHUB_TOKEN?: string;
  /** Local development only: skips Google and signs in as this address on localhost. */
  DEV_EMAIL?: string;
}
