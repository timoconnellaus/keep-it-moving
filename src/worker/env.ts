import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { InterviewHub } from "./hub.js";

export interface Env {
  HUB: DurableObjectNamespace<InterviewHub>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ASSETS: Fetcher;
  /** The public origin, e.g. https://interviewer.zerobsai.com. */
  PUBLIC_URL: string;
  /** The one account allowed in. */
  ALLOWED_EMAIL: string;
  /** The Zero Trust team domain whose Access login guards the browser pages. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access application's audience tag. */
  ACCESS_AUD: string;
  /** Local development only: skips Access and signs in as this address on localhost. */
  DEV_EMAIL?: string;
}
