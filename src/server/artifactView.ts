/**
 * Serves an html artifact as its own sandbox, even if opened directly:
 * scripts run with an opaque origin that can't read or write the API, and
 * requests it makes carry no referrer (which would include the session token).
 * Only this site's pages may frame it.
 */
export const ARTIFACT_VIEW_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
};

/**
 * Whether a request would show the artifact as a whole page, which would
 * let anyone's HTML pose as this site (a fake sign-in, say) at a link they
 * send. The page only ever frames it. A browser that sends no
 * Sec-Fetch-Dest gets it, still sandboxed.
 */
export const opensAsPage = (request: Request) =>
  request.headers.get("sec-fetch-dest") === "document";
