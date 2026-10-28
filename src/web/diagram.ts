/**
 * Gives an SVG a fixed pixel size from its viewBox, so an <img> of it has an
 * intrinsic size even when the SVG says width="100%".
 */
function sized(svg: string): string {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  const viewBox = root
    .getAttribute("viewBox")
    ?.split(/[\s,]+/)
    .map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    root.setAttribute("width", String(Math.ceil(viewBox[2]!)));
    root.setAttribute("height", String(Math.ceil(viewBox[3]!)));
    root.style.removeProperty("max-width");
  }
  return new XMLSerializer().serializeToString(root);
}

/** An SVG diagram as an image URL; in an <img>, script inside it never runs. */
export function svgImageUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized(svg))}`;
}
