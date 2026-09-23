/** A picture of the stage for Gemini, as base64 without the data: prefix. */
export type StageImage = { mimeType: "image/jpeg"; data: string };

/** Gemini tokenizes images in tiles; larger pictures cost more and add little. */
const MAX_IMAGE_SIDE = 1024;
const CAPTURE_TIMEOUT_MS = 5_000;

let captureCounter = 0;

/** Asks an artifact frame (served with the server's capture listener) for a JPEG of itself. */
export async function captureFrame(
  frame: HTMLIFrameElement,
): Promise<StageImage | null> {
  const target = frame.contentWindow;
  if (!target) return null;
  const id = `capture-${++captureCounter}`;
  const url = await new Promise<string | null>((resolve) => {
    const finish = (value: string | null) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; id?: string; url?: string };
      if (
        event.source === target &&
        data?.type === "interviewer:capture-result" &&
        data.id === id
      )
        finish(data.url ?? null);
    };
    const timer = setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    target.postMessage({ type: "interviewer:capture", id }, "*");
  });
  return url ? downscale(url) : null;
}

/** Rasterizes an image URL (e.g. a diagram's SVG data URL) to a JPEG. */
export function captureImage(url: string): Promise<StageImage | null> {
  return downscale(url);
}

async function downscale(url: string): Promise<StageImage | null> {
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(
      1,
      MAX_IMAGE_SIDE / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL("image/jpeg", 0.85);
    return { mimeType: "image/jpeg", data: jpeg.slice(jpeg.indexOf(",") + 1) };
  } catch {
    // Undecodable or cross-origin-tainted images can't be sent; text still is.
    return null;
  }
}
