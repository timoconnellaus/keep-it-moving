import { canvasMeasure, estimateWidth, type Measure } from "../svg.js";

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
