/**
 * Serves an html artifact as its own sandbox, even if opened directly:
 * scripts run with an opaque origin that can't read or write the API, and
 * requests it makes carry no referrer (which would include the session token).
 */
export const ARTIFACT_VIEW_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "sandbox allow-scripts",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
};
