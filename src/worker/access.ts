import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env.js";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * The email Cloudflare Access verified for this request, or null. Access
 * guards every browser page at the edge; checking its JWT here as well means
 * a misconfigured Access policy fails closed.
 */
export async function accessEmail(
  request: Request,
  env: Env,
): Promise<string | null> {
  if (env.DEV_EMAIL && isLoopback(new URL(request.url).hostname))
    return env.DEV_EMAIL;
  const token =
    request.headers.get("cf-access-jwt-assertion") ??
    cookie(request, "CF_Authorization");
  if (!token || !env.ACCESS_AUD) return null;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: env.ACCESS_AUD,
    });
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

export const isAllowed = (email: string | null | undefined, env: Env) =>
  Boolean(email) &&
  email!.toLowerCase() === env.ALLOWED_EMAIL.trim().toLowerCase();

export function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}
