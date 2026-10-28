import type { Env } from "./env.js";

/** The owner's workspace keeps the name it had when there was only one. */
const OWNER_HUB = "interviews";

const isOwner = (email: string, env: Env) =>
  !!env.OWNER_EMAIL &&
  email.toLowerCase() === env.OWNER_EMAIL.trim().toLowerCase();

/**
 * Each user's workspace is its own InterviewHub, and everything they own
 * (interviews, keys, devices) lives in it. This is the one
 * place an email becomes a Durable Object.
 */
export function hubFor(env: Env, email: string) {
  const name = isOwner(email, env)
    ? OWNER_HUB
    : `user:${email.trim().toLowerCase()}`;
  return env.HUB.get(env.HUB.idFromName(name));
}
