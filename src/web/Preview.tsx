import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ControlValues } from "../shared/bindings.js";
import type { ArtifactView, PinView } from "../shared/schema.js";
import { frameSize } from "./canvasLayout.js";
import {
  ArtifactDocument,
  pickIn,
  spotInDocument,
  useFrameSource,
  useFrameValues,
  type Spot,
} from "./frames.js";

export const DEVICES = {
  desktop: { label: "Desktop", w: 1280, h: 0, bezel: 0, radius: 0 },
  tablet: { label: "Tablet", w: 834, h: 1112, bezel: 14, radius: 34 },
  mobile: { label: "Mobile", w: 390, h: 844, bezel: 11, radius: 46 },
};
export type Device = keyof typeof DEVICES;
export const deviceFor = (width: number): Device =>
  width <= 430 ? "mobile" : width <= 900 ? "tablet" : "desktop";

const DEVICE_ICONS: Record<Device, React.ReactNode> = {
  desktop: (
    <svg width="15" height="13" viewBox="0 0 15 13" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="13"
        height="8.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M5 12h5M7.5 9.5V12"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  tablet: (
    <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="10"
        height="12"
        rx="1.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M5 10.8h2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  mobile: (
    <svg width="9" height="14" viewBox="0 0 9 14" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="7"
        height="12"
        rx="1.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M3.6 10.8h1.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
};

export function CommentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M7 1.5a5.5 5.5 0 0 0-4.8 8.2L1.5 12.5l2.9-.8A5.5 5.5 0 1 0 7 1.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function FitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M1.5 5V1.5H5M9 1.5h3.5V5M12.5 9v3.5H9M5 12.5H1.5V9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Where a comment goes: a spot, at the width the document was shown at. */
export type Placed = Spot & { width: number };

interface Geometry {
  kind: "bare" | "bezel" | "browser" | "paper";
  /** Scale, at most 1: the device is shown at real size when it fits. */
  s: number;
  /** The screen: the document's viewport. */
  w: number;
  h: number;
  /** The whole device, chrome included. */
  ow: number;
  oh: number;
}

/**
 * One frame at its real size and fully interactive, over the canvas column
 * or the whole window. Html artifacts take a device width; it is scaled
 * down only when the device doesn't fit.
 */
export function Preview({
  token,
  artifact,
  title,
  values,
  pins,
  device,
  setDevice,
  full,
  setFull,
  commenting,
  setCommenting,
  onClose,
  onPlace,
  embedded = false,
  picker,
  tools,
  landscape = false,
  reloadKey = 0,
}: {
  token: string;
  artifact: ArtifactView;
  title: string;
  /** An html artifact's controls, with any unsaved preview. */
  values: ControlValues | undefined;
  /** Pins on this artifact, sent and about to be. */
  pins: PinView[];
  device: Device;
  setDevice(device: Device): void;
  full: boolean;
  setFull(full: boolean): void;
  commenting: boolean;
  setCommenting(on: boolean): void;
  /** Without it there's no Close button, as in a tab that is the preview. */
  onClose?: () => void;
  onPlace(placed: Placed): void;
  /** Shown in place of the column, rather than over the canvas. */
  embedded?: boolean;
  /** In place of the name, such as a choice between the tab's artifacts. */
  picker?: React.ReactNode;
  /** More buttons, after the device widths. */
  tools?: React.ReactNode;
  /** A tablet or phone turned on its side. */
  landscape?: boolean;
  /** Changing it reloads an html artifact. */
  reloadKey?: number;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const catcherRef = useRef<HTMLDivElement>(null);
  const frame = useFrameValues(values);
  const source = useFrameSource(token, artifact);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  // Which load of the frame the pins were sent to: a reload is a new page.
  const [loaded, setLoaded] = useState<string | null>(null);
  const frameKey = `${artifact.id}:${reloadKey}`;
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setBox({ w: body.clientWidth, h: body.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
  const html = artifact.format === "html";
  const pinsKey = JSON.stringify(pins);
  useEffect(() => {
    if (html && loaded === frameKey)
      frame.ref.current?.contentWindow?.postMessage(
        { type: "kim-pins", pins: JSON.parse(pinsKey) as PinView[] },
        "*",
      );
  }, [html, loaded, frameKey, pinsKey]);

  const page = frameSize(artifact).w;
  const base = html ? DEVICES[device] : { w: page, h: 0, bezel: 0, radius: 0 };
  const dev = landscape && base.h ? { ...base, w: base.h, h: base.w } : base;
  let geo: Geometry | null = null;
  if (box) {
    const pad = box.w < 560 ? 12 : 28;
    const aw = box.w - pad * 2;
    const ah = box.h - pad * 2;
    if (
      html &&
      device === "mobile" &&
      !landscape &&
      box.w < dev.w + 2 * dev.bezel + 2 * pad
    ) {
      // A phone-sized screen: the page itself, edge to edge, no device drawn.
      const s = Math.min(1, box.w / dev.w);
      geo = {
        kind: "bare",
        s,
        w: dev.w,
        h: box.h / s,
        ow: dev.w,
        oh: box.h / s,
      };
    } else if (dev.h) {
      const ow = dev.w + 2 * dev.bezel;
      const oh = dev.h + 2 * dev.bezel;
      geo = {
        kind: "bezel",
        s: Math.min(1, aw / ow, ah / oh),
        w: dev.w,
        h: dev.h,
        ow,
        oh,
      };
    } else {
      // A browser window as tall as the space allows, up to a tall laptop screen.
      const chrome = html ? 36 : 0;
      const s = Math.min(1, aw / dev.w);
      const oh = Math.min(ah / s, 1100 + chrome);
      geo = {
        kind: html ? "browser" : "paper",
        s,
        w: dev.w,
        h: oh - chrome,
        ow: dev.w,
        oh,
      };
    }
  }

  const place = async (event: React.MouseEvent<HTMLDivElement>) => {
    if (!geo) return;
    const { clientX, clientY } = event;
    const scale = geo.s;
    const width = geo.w;
    if (html) {
      const screen = event.currentTarget.getBoundingClientRect();
      const x = (clientX - screen.left) / scale;
      const y = (clientY - screen.top) / scale;
      const win = frame.ref.current?.contentWindow;
      const spot = (win && (await pickIn(win, x, y))) ?? {
        element: "page",
        selector: null,
        fx: 0,
        fy: 0,
        x,
        y,
      };
      onPlace({ ...spot, width });
      return;
    }
    // The catcher steps aside so the point finds the document under it.
    const catcher = catcherRef.current;
    if (catcher) catcher.style.display = "none";
    const spot = spotInDocument(pageRef.current!, clientX, clientY, scale);
    if (catcher) catcher.style.display = "";
    onPlace({ ...spot, width });
  };

  const name = title.replace(/ · (Desktop|Mobile|Tablet)$/, "");
  return (
    <div
      className={`preview${full ? " full" : ""}${embedded ? " embedded" : ""}`}
      role={embedded ? "region" : "dialog"}
      aria-label={`Preview of ${title}`}
    >
      <div className="preview-bar">
        {picker ?? (
          <span className="preview-name" title={title}>
            {name}
          </span>
        )}
        {html && (
          <div className="seg" role="group" aria-label="Device width">
            {(Object.keys(DEVICES) as Device[]).map((key) => (
              <button
                key={key}
                type="button"
                className={key === device ? "on" : ""}
                aria-pressed={key === device}
                title={`${DEVICES[key].label} · ${DEVICES[key].w}px`}
                onClick={() => setDevice(key)}
              >
                {DEVICE_ICONS[key]}
                <span className="seg-text">{DEVICES[key].label}</span>
                <span className="seg-num">{DEVICES[key].w}</span>
              </button>
            ))}
          </div>
        )}
        {tools}
        <button
          type="button"
          className={`pbtn${commenting ? " on" : ""}`}
          aria-pressed={commenting}
          title="Comment (C)"
          onClick={() => setCommenting(!commenting)}
        >
          <CommentIcon />
          <span className="ptext">Comment</span>
        </button>
        <button
          type="button"
          className="pbtn full-toggle"
          title={full ? "Exit full screen (Esc)" : "Open full screen"}
          onClick={() => setFull(!full)}
        >
          {full ? (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M5 1.5V5H1.5M9 1.5V5h3.5M12.5 9H9v3.5M1.5 9H5v3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <FitIcon />
          )}
          <span className="ptext">
            {full ? "Exit full screen" : "Open full screen"}
          </span>
        </button>
        {onClose && (
          <button
            type="button"
            className="pbtn close"
            title="Close (Esc)"
            aria-label="Close preview"
            onClick={onClose}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M2 2l8 8M10 2l-8 8"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
            <span className="ptext">Close</span>
          </button>
        )}
      </div>
      <div
        className={`preview-body${geo?.kind === "bare" ? " bare" : ""}`}
        ref={bodyRef}
      >
        {geo && (
          <div
            className="sizer"
            style={{ width: geo.ow * geo.s, height: geo.oh * geo.s }}
          >
            <div
              className={`device ${geo.kind}`}
              style={
                {
                  width: geo.ow,
                  height: geo.oh,
                  transform: `scale(${geo.s})`,
                  "--b": `${dev.bezel}px`,
                  "--r": `${dev.radius}px`,
                } as React.CSSProperties
              }
            >
              {geo.kind === "browser" && (
                <div className="browser-bar" aria-hidden="true">
                  <span className="dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="url">{artifact.title}</span>
                </div>
              )}
              <div
                className={`screen${html ? "" : " scrolls"}`}
                style={{ width: geo.w, height: geo.h }}
              >
                {html ? (
                  <iframe
                    key={frameKey}
                    ref={frame.ref}
                    title={`${title}, interactive preview`}
                    // Isolated by the server's CSP sandbox header, as on the
                    // canvas, or by the sandbox attribute when sealed.
                    {...source}
                    onLoad={() => {
                      frame.onLoad();
                      setLoaded(frameKey);
                    }}
                  />
                ) : (
                  <div className="page" ref={pageRef}>
                    <ArtifactDocument artifact={artifact} />
                    {pins.map((pin) => (
                      <PinMark key={pin.n} pin={pin} />
                    ))}
                  </div>
                )}
                {commenting && (
                  <div
                    className="catcher"
                    ref={catcherRef}
                    onClick={(event) => void place(event)}
                  />
                )}
              </div>
            </div>
          </div>
        )}
        {commenting && (
          <span className="comment-hint preview-hint">
            Click the page to pin a comment · Esc to cancel
          </span>
        )}
      </div>
    </div>
  );
}

/** A numbered pin at a point of a document the page renders itself. */
export function PinMark({ pin }: { pin: PinView }) {
  return (
    <div className="pin-at" style={{ left: pin.x, top: pin.y }}>
      <span className="pin">{pin.n}</span>
    </div>
  );
}
