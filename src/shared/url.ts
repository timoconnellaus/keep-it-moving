/** Only web links: a stored "javascript:" URL must never become a live href. */
export function isWebUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** The URL if it's http(s), else undefined (the link renders without one). */
export const safeHref = (value: string | null | undefined) =>
  value && isWebUrl(value) ? value : undefined;
