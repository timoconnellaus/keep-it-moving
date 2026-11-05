import { describe, expect, it } from "vitest";
import { IMAGE_MAX_BYTES, inlineImages } from "../src/inlineImages.js";

const png = (size = 4) => ({
  ok: true,
  contentType: "image/png",
  bytes: new Uint8Array(size),
});

describe("embedding a page's web images", () => {
  it("embeds img, poster and CSS images, once per URL", async () => {
    const fetched: string[] = [];
    const { html, embedded } = await inlineImages(
      `<img src="https://x.dev/a.png?w=1&amp;h=2"><video poster='https://x.dev/a.png?w=1&h=2'></video><div style="background:url(https://x.dev/b.png)"></div>`,
      async (url) => (fetched.push(url), png()),
    );
    expect(fetched).toEqual([
      "https://x.dev/a.png?w=1&h=2",
      "https://x.dev/b.png",
    ]);
    expect(embedded).toBe(2);
    expect(html).not.toContain("https://");
    expect(html.match(/data:image\/png;base64,AAAAAA==/g)).toHaveLength(3);
  });

  it("leaves fonts, failures, non-images and big images as they are", async () => {
    const { html, embedded, skipped } = await inlineImages(
      `<link href="https://fonts.googleapis.com/css2?family=Inter"><img src="https://x.dev/missing.png"><img src="https://x.dev/page"><img src="https://x.dev/big.png">`,
      async (url) =>
        url.includes("missing")
          ? null
          : url.includes("page")
            ? { ok: true, contentType: "text/html", bytes: new Uint8Array(3) }
            : png(IMAGE_MAX_BYTES + 1),
    );
    expect(embedded).toBe(0);
    expect(skipped).toHaveLength(3);
    expect(html).toContain("https://x.dev/big.png");
  });
});
