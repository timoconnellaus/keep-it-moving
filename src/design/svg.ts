/** Small helpers for building SVG and HTML as strings. */

export const esc = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const attr = (text: string): string => esc(text).replace(/"/g, "&quot;");

/** Width in pixels of `text` set in a CSS `font` shorthand. */
export type Measure = (text: string, font: string) => number;

/**
 * A measure that needs no DOM: average glyph widths for the site's fonts.
 * Slightly generous, so text measured this way fits when the real font loads.
 */
export const estimateWidth: Measure = (text, font) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12);
  const bold = /^\s*(?:italic\s+)?(?:600|700|bold)/.test(font) ? 1.06 : 1;
  const per = /mono/i.test(font) ? 0.61 : /outfit/i.test(font) ? 0.58 : 0.56;
  let units = 0;
  for (const ch of text)
    units += /[A-Z]/.test(ch) ? 1.2 : /[il.,:;|'!]/.test(ch) ? 0.55 : 1;
  if (/mono/i.test(font)) units = [...text].length;
  return units * size * per * bold;
};
