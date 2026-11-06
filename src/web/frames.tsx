import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ControlValues } from "../shared/bindings.js";
import type { ArtifactView } from "../shared/schema.js";
import { artifactViewUrl } from "../shared/workspace.js";
import { renderArtifact } from "../server/artifactView.js";
import { svgImageUrl } from "./diagram.js";
import { encryption, KidContext } from "./keys.js";

/** Opened artifacts, by interview key, artifact and revision. */
const opened = new Map<string, Promise<string | null>>();

/**
 * How an html artifact's frame gets its page. A plain interview's is
 * served sandboxed at its own URL. An encrypted one's is fetched sealed,
 * opened here and framed from memory, sandboxed the same way: scripts run
 * in an opaque origin that can't reach this page or its API.
 */
export function useFrameSource(
  token: string,
  artifact: ArtifactView,
  embed: boolean,
): { src?: string; srcDoc?: string; sandbox?: string } {
  const kid = useContext(KidContext);
  const html = artifact.format === "html";
  const key = `${kid}:${artifact.id}:${artifact.revision}`;
  const [content, setContent] = useState<{ key: string; html: string } | null>(
    null,
  );
  useEffect(() => {
    if (!kid || !html) return;
    let live = true;
    let load = opened.get(key);
    if (!load) {
      load = fetch(`/api/browser/${token}/artifacts/${artifact.id}/content`)
        .then((response) =>
          response.ok
            ? (response.json() as Promise<{ content: string }>)
            : null,
        )
        .then((body) => (body ? encryption.unseal(body.content) : null))
        .catch(() => null);
      opened.set(key, load);
    }
    void load.then((value) => {
      if (live && value !== null) setContent({ key, html: value });
    });
    return () => {
      live = false;
    };
  }, [kid, html, key, token]);
  const srcDoc = useMemo(
    () =>
      content?.key === key
        ? renderArtifact(
            content.html,
            {},
            { query: `?theme=light${embed ? "&embed=1" : ""}` },
          )
        : undefined,
    [content, key, embed],
  );
  if (!html) return {};
  if (!kid) return { src: artifactViewUrl(token, artifact, { embed }) };
  return srcDoc ? { srcDoc, sandbox: "allow-scripts" } : {};
}

/**
 * Keeps an html artifact's controls at `values`: posted to the frame's
 * applier when it loads and whenever they change. Undefined leaves the
 * frame as served. The frame's origin is opaque, so it can't be named as
 * the target; the values are the user's own answers.
 */
export function useFrameValues(values: ControlValues | undefined) {
  const ref = useRef<HTMLIFrameElement>(null);
  const key = values ? JSON.stringify(values) : null;
  const post = () => {
    if (key !== null)
      ref.current?.contentWindow?.postMessage(
        { type: "kim-set", values: JSON.parse(key) as ControlValues },
        "*",
      );
  };
  useEffect(post, [key]);
  return { ref, onLoad: post };
}

/** What the comments script inside an html artifact says is at a point. */
export interface Spot {
  element: string;
  selector: string | null;
  fx: number;
  fy: number;
  /** In the document's pixels, scroll included. */
  x: number;
  y: number;
}

/** Messages only count from html frames on this page; artifacts are anyone's HTML. */
const fromFrame = (source: MessageEventSource | null) =>
  [...document.querySelectorAll("iframe")].some(
    (frame) => frame.contentWindow === source,
  );

const picks = new Map<string, (spot: Spot) => void>();
const escapes = new Set<() => void>();
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as {
      type?: unknown;
      req?: unknown;
      key?: unknown;
    } & Partial<Spot>;
    if (!data || typeof data !== "object" || !fromFrame(event.source)) return;
    if (data.type === "kim-picked" && typeof data.req === "string") {
      const resolve = picks.get(data.req);
      picks.delete(data.req);
      resolve?.({
        element: String(data.element ?? "page").slice(0, 300) || "page",
        selector: typeof data.selector === "string" ? data.selector : null,
        fx: clamp(Number(data.fx)),
        fy: clamp(Number(data.fy)),
        x: Number(data.x) || 0,
        y: Number(data.y) || 0,
      });
    }
    if (data.type === "kim-key" && data.key === "Escape")
      escapes.forEach((escape) => escape());
  });
}
const clamp = (value: number) =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/**
 * Asks an html frame what is at a point of its viewport. Null when it
 * doesn't answer, such as an artifact served before comments existed.
 */
export function pickIn(
  win: Window,
  x: number,
  y: number,
): Promise<Spot | null> {
  listen();
  const req = crypto.randomUUID();
  return new Promise((resolve) => {
    picks.set(req, resolve);
    win.postMessage({ type: "kim-pick", req, x, y }, "*");
    setTimeout(() => {
      if (picks.delete(req)) resolve(null);
    }, 600);
  });
}

/** Esc pressed inside any html frame, which keeps its own key presses. */
export function useFrameEscape(onEscape: () => void) {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    listen();
    const escape = () => latest.current();
    escapes.add(escape);
    return () => void escapes.delete(escape);
  }, []);
}

const BLOCK = "h1, h2, h3, h4, h5, h6, p, li, td, th, pre, blockquote, img";
const clip = (text: string) => {
  const squashed = text.replace(/\s+/g, " ").trim();
  return squashed.length > 40 ? `${squashed.slice(0, 39)}…` : squashed;
};

/**
 * The spot at a point of a document the page renders itself (a plan, a
 * diagram), described the way the comments script describes html. The
 * point is on screen; `scale` is the document's on-screen size over its own.
 */
export function spotInDocument(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  scale: number,
): Spot {
  const box = root.getBoundingClientRect();
  const x = (clientX - box.left) / scale;
  const y = (clientY - box.top) / scale;
  const hit = document.elementFromPoint?.(clientX, clientY);
  const block = hit && root.contains(hit) ? hit.closest(BLOCK) : null;
  if (!block || !root.contains(block))
    return { element: "page", selector: null, fx: 0, fy: 0, x, y };
  const r = block.getBoundingClientRect();
  const tag = block.tagName.toLowerCase();
  const text = clip(block.getAttribute("alt") ?? block.textContent ?? "");
  return {
    element: text ? `${tag} "${text}"` : tag,
    selector: null,
    fx: r.width ? clamp((clientX - r.left) / r.width) : 0,
    fy: r.height ? clamp((clientY - r.top) / r.height) : 0,
    x,
    y,
  };
}

/** A plan, document or diagram the page renders itself, rather than in a frame. */
export function ArtifactDocument({ artifact }: { artifact: ArtifactView }) {
  const imageUrl = useMemo(
    () =>
      artifact.format === "svg" && artifact.content
        ? svgImageUrl(artifact.content)
        : null,
    [artifact.format, artifact.content],
  );
  if (artifact.format === "svg" && imageUrl)
    return (
      <div className="diagram">
        <img src={imageUrl} alt={artifact.title} />
      </div>
    );
  if (artifact.format === "text" || artifact.format === "svg")
    return (
      <div className="stage-error">
        <p>This diagram isn’t archify or SVG, so it’s shown as source.</p>
        <pre>{artifact.content}</pre>
      </div>
    );
  return (
    <article className="doc">
      <Markdown remarkPlugins={[remarkGfm]}>{artifact.content ?? ""}</Markdown>
    </article>
  );
}

/** The desktop size an html thumbnail renders at before it's scaled down. */
const THUMB_FRAME_WIDTH = 1200;

/**
 * Keeps `--thumb-scale` on the thumbnail at its width over the frame's, so
 * the whole frame fits it at any card width: set before the first paint,
 * then whenever the card resizes.
 */
function useThumbScale() {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback((thumb: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!thumb) return;
    const fit = (width: number) =>
      thumb.style.setProperty(
        "--thumb-scale",
        String(width / THUMB_FRAME_WIDTH),
      );
    fit(thumb.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => {
      if (entry) fit(entry.contentRect.width);
    });
    observer.current.observe(thumb);
  }, []);
}

/** A small preview for choosing between artifacts, such as layout mockups. */
export function ArtifactThumb({
  token,
  artifact,
  values,
}: {
  token: string;
  artifact: ArtifactView;
  /** Controls to show applied, such as one option's. */
  values?: ControlValues | undefined;
}) {
  const frame = useFrameValues(values);
  const thumb = useThumbScale();
  const source = useFrameSource(token, artifact, artifact.kind === "diagram");
  if (artifact.format === "html")
    return (
      <div className="thumb" ref={thumb} aria-hidden="true">
        <iframe
          title=""
          tabIndex={-1}
          ref={frame.ref}
          onLoad={frame.onLoad}
          // No sandbox attribute: the server's CSP sandbox header isolates
          // the document (opaque origin, no popups, forms, or top-level
          // navigation), and some embedded browsers refuse to load
          // sandbox-attributed frames over the network.
          {...source}
        />
      </div>
    );
  if (artifact.format === "svg" && artifact.content)
    return (
      <div className="thumb thumb-diagram" aria-hidden="true">
        <div className="diagram">
          <img src={svgImageUrl(artifact.content)} alt="" />
        </div>
      </div>
    );
  return (
    <div className="thumb thumb-doc" aria-hidden="true">
      {artifact.title}
    </div>
  );
}
