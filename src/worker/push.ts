import { importJWK, SignJWT, type JWK } from "jose";
import type { PushSender } from "../server/hub.js";
import type { Env } from "./env.js";

/**
 * Web Push without a payload: a VAPID-signed empty POST to the device's
 * push service wakes the service worker, which asks the server what is
 * waiting. No payload means no message encryption.
 */
export function webPush(
  env: Env,
): { publicKey: string; send: PushSender } | undefined {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK) return undefined;
  let key: Promise<CryptoKey | Uint8Array> | null = null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    async send(endpoint) {
      key ??= importJWK(JSON.parse(env.VAPID_PRIVATE_JWK!) as JWK, "ES256");
      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", typ: "JWT" })
        .setAudience(new URL(endpoint).origin)
        .setExpirationTime("12h")
        .setSubject(
          env.OWNER_EMAIL ? `mailto:${env.OWNER_EMAIL}` : env.PUBLIC_URL,
        )
        .sign(await key);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
          ttl: "86400",
          urgency: "high",
          "content-length": "0",
        },
      });
      return response.status;
    },
  };
}
