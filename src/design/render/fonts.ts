import { estimateWidth, type Measure } from "../svg.js";

const FONTS = [
  "600 13.5px Outfit",
  "400 11.5px 'JetBrains Mono'",
  "600 11.5px 'JetBrains Mono'",
  "400 11px Figtree",
  "600 10px Figtree",
];

/** Waits (briefly) for the site's fonts, then measures with them. */
export async function loadedMeasure(): Promise<Measure> {
  if (typeof document === "undefined" || !("fonts" in document))
    return estimateWidth;
  try {
    await Promise.race([
      Promise.all(FONTS.map((f) => document.fonts.load(f))),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  } catch {
    /* fall back to whatever is there */
  }
  return canvasMeasure();
}

/** A measure backed by a canvas, for when the fonts are loaded. */
function canvasMeasure(): Measure {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return estimateWidth;
  const cache = new Map<string, number>();
  return (text, font) => {
    const key = `${font}\u0000${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      context.font = font;
      // A little slack for fallbacks when the SVG is viewed elsewhere.
      width = Math.max(
        context.measureText(text).width,
        estimateWidth(text, font) * 0.92,
      );
      cache.set(key, width);
    }
    return width;
  };
}
