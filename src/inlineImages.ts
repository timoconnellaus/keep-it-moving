/**
 * Embeds the images an html page loads from the web as `data:` URLs, so
 * it shows them where nothing may be fetched, such as an Orca plugin's
 * panel. Images over the size cap, or that don't load, are left as they
 * are; the viewer shows a placeholder for them.
 */

/** One image at most this big is embedded. */
export const IMAGE_MAX_BYTES = 600_000;
/** Embedding stops adding images past this many bytes in all. */
export const IMAGES_MAX_BYTES = 4_000_000;

const ATTRIBUTE = /(\s(?:src|poster)\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi;
const CSS_URL = /url\(\s*(["']?)(https?:\/\/[^"')\s]+)\1\s*\)/gi;
/** Fonts and stylesheets are the viewer's to supply, not images. */
const NOT_IMAGES =
  /fonts\.(googleapis|gstatic)\.com|\.(css|js|woff2?|ttf|otf)(\?|$)/i;

export type Fetcher = (url: string) => Promise<{
  ok: boolean;
  contentType: string | null;
  bytes: Uint8Array;
} | null>;

export async function inlineImages(
  html: string,
  fetchImage: Fetcher,
): Promise<{ html: string; embedded: number; skipped: string[] }> {
  const urls = new Set<string>();
  for (const match of html.matchAll(ATTRIBUTE)) urls.add(decode(match[3]!));
  for (const match of html.matchAll(CSS_URL)) urls.add(decode(match[2]!));
  const found = new Map<string, string>();
  const skipped: string[] = [];
  let total = 0;
  for (const url of urls) {
    if (NOT_IMAGES.test(url)) continue;
    const image = await fetchImage(url).catch(() => null);
    const type = image?.contentType?.split(";")[0]?.trim() ?? "";
    if (
      !image?.ok ||
      !type.startsWith("image/") ||
      image.bytes.byteLength > IMAGE_MAX_BYTES ||
      total + image.bytes.byteLength > IMAGES_MAX_BYTES
    ) {
      skipped.push(url);
      continue;
    }
    total += image.bytes.byteLength;
    found.set(url, `data:${type};base64,${toBase64(image.bytes)}`);
  }
  const swap = (url: string) => found.get(decode(url));
  const out = html
    .replace(ATTRIBUTE, (all, before: string, quote: string, url: string) => {
      const data = swap(url);
      return data ? `${before}${quote}${data}${quote}` : all;
    })
    .replace(CSS_URL, (all, quote: string, url: string) => {
      const data = swap(url);
      return data ? `url(${quote}${data}${quote})` : all;
    });
  return { html: out, embedded: found.size, skipped };
}

const decode = (url: string) => url.replace(/&amp;/g, "&");

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Fetches an image for inlineImages, giving up after a few seconds. */
export const fetchImage: Fetcher = async (url) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    redirect: "follow",
  });
  if (!response.ok)
    return { ok: false, contentType: null, bytes: new Uint8Array() };
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > IMAGE_MAX_BYTES) {
    await response.body?.cancel();
    return { ok: false, contentType: null, bytes: new Uint8Array() };
  }
  return {
    ok: true,
    contentType: response.headers.get("content-type"),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
};
