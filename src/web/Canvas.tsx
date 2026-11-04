import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useStore,
  useStoreApi,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ControlValues } from "../shared/bindings.js";
import type {
  ArtifactView,
  FramePosition,
  PinView,
  QuestionView,
  SessionView,
} from "../shared/schema.js";
import { artifactViewUrl } from "../shared/workspace.js";
import { plainText } from "./inline.js";
import { labelSpace, layoutCanvas, PAGE_HEIGHT } from "./canvasLayout.js";
import {
  ArtifactDocument,
  pickIn,
  spotInDocument,
  useFrameEscape,
  useFrameValues,
  type Spot,
} from "./frames.js";
import {
  CommentIcon,
  deviceFor,
  FitIcon,
  PinMark,
  Preview,
  type Device,
  type Placed,
} from "./Preview.js";

const reduceMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const fitMs = () => (reduceMotion() ? 0 : 520);
/** "Layout A · Desktop": a copy names its option instead. */
const DEVICE_SUFFIX = / · (Desktop|Tablet|Mobile)$/;
/** A label always has room for its play button and a readable name. */
const LABEL_MIN = 112;
/** With nothing to its right, a label stops here. */
const LABEL_MAX = 560;
const GAP = 8;
let measurer: CanvasRenderingContext2D | null | undefined;
/** A label part's width on screen, from the label's fonts. */
function textWidth(text: string, font: string): number {
  measurer ??= document.createElement("canvas").getContext?.("2d") ?? null;
  if (!measurer) return text.length * 7;
  measurer.font = font;
  return Math.ceil(measurer.measureText(text).width);
}

/**
 * Which of a label's extras fit beside its name, most useful first: the
 * "Use" button, then the tag, then the size. When even the name doesn't
 * fit, it truncates and the extras go.
 */
function labelParts(
  room: number,
  name: string,
  extras: { use?: string; tag?: string; size?: string },
) {
  const body = '"Figtree", ui-sans-serif, system-ui, sans-serif';
  let used = 20 + GAP + textWidth(name, `600 12px ${body}`) + 4;
  const widths = {
    use: extras.use ? textWidth(extras.use, `600 11px ${body}`) + 20 : 0,
    tag: extras.tag ? textWidth(extras.tag, `600 11px ${body}`) + 16 : 0,
    size: extras.size
      ? textWidth(extras.size, '500 11px "JetBrains Mono", monospace')
      : 0,
  };
  const shown = { use: false, tag: false, size: false };
  for (const part of ["use", "tag", "size"] as const) {
    if (!extras[part] || used + GAP + widths[part] > room) continue;
    shown[part] = true;
    used += GAP + widths[part];
  }
  return shown;
}

/** Below this zoom a frame is too small to read, so it isn't loaded. */
const MIN_ZOOM_LIVE = 0.08;
/** How far outside the canvas a frame still counts as in view, in screen pixels. */
const VIEW_MARGIN = 160;

/** How a frame stands out for the question in hand. */
export interface FrameHighlight {
  /** The pointer is on an option this frame shows. */
  hot: boolean;
  /** It shows the option chosen so far. */
  picked: boolean;
  tag: { kind: "" | "live"; text: string } | null;
}

/** "Compare side by side": a copy of a bound artifact for each option. */
export interface Comparison {
  question: QuestionView;
  artifact: ArtifactView;
  /** The options chosen so far. */
  selected: string[];
  valuesFor(option: string): ControlValues;
  onUse(option: string): void;
}

/** A comment's pin, placed but not yet sent. */
export type PlacedPin = Placed & { artifactId: string; title: string };

type Mode = "move" | "comment";

interface FrameData extends Record<string, unknown> {
  artifact: ArtifactView;
  title: string;
  w: number;
  h: number | null;
  /** On a comparison's copy: the option it shows. */
  option?: string;
  /** Room for the label, up to the next frame on the right; null for no limit. */
  space: number | null;
}
interface RowData extends Record<string, unknown> {
  title: string;
  note: string;
}
type FrameNodeType = Node<FrameData, "frame">;
type RowNodeType = Node<RowData, "row">;
type CanvasNode = FrameNodeType | RowNodeType;

interface Live {
  token: string;
  mode: Mode;
  selected: string | null;
  pins: PinView[];
  compare: Comparison | null;
  valuesFor(artifactId: string): ControlValues;
  highlight(artifactId: string): FrameHighlight;
  select(id: string): void;
  openPreview(id: string): void;
  comment(target: {
    data: FrameData;
    win: Window | null;
    page: HTMLElement | null;
    clientX: number;
    clientY: number;
    x: number;
    y: number;
    scale: number;
  }): void;
}
const LiveContext = createContext<Live | null>(null);

/** Writes 1/zoom to the stage, so labels and pins keep their screen size. */
function InvZoom({ stage }: { stage: React.RefObject<HTMLElement | null> }) {
  const zoom = useStore((s) => s.transform[2]);
  useLayoutEffect(() => {
    stage.current?.style.setProperty("--inv", String(1 / zoom));
  }, [zoom]);
  return null;
}

function ZoomReadout() {
  const zoom = useStore((s) => Math.round(s.transform[2] * 100));
  return <span className="zoom-readout">{zoom}%</span>;
}

function RowNode({ data }: NodeProps<RowNodeType>) {
  return (
    <div className="row-node">
      <div className="row-label">
        <b>{data.title}</b>
        {data.note && <span>{plainText(data.note)}</span>}
      </div>
    </div>
  );
}

/**
 * One artifact on the canvas, under a label that keeps its screen size at
 * any zoom. An html frame loads its document only while it's in view and
 * big enough to read; otherwise it's a light placeholder.
 */
function FrameNode({
  id,
  data,
  positionAbsoluteX: x,
  positionAbsoluteY: y,
}: NodeProps<FrameNodeType>) {
  const live = useContext(LiveContext)!;
  const { artifact, w, h, option } = data;
  const html = artifact.format === "html";
  const mounted = useStore(
    useCallback(
      (s: ReactFlowState) => {
        const [tx, ty, zoom] = s.transform;
        const left = x * zoom + tx;
        const top = y * zoom + ty;
        return (
          zoom >= MIN_ZOOM_LIVE &&
          left < s.width + VIEW_MARGIN &&
          left + w * zoom > -VIEW_MARGIN &&
          top < s.height + VIEW_MARGIN &&
          top + (h ?? PAGE_HEIGHT) * zoom > -VIEW_MARGIN
        );
      },
      [x, y, w, h],
    ),
  );
  // The label's room on screen: up to the next frame, at least a readable name.
  const room = useStore(
    useCallback(
      (s: ReactFlowState) =>
        Math.round(
          Math.max(
            LABEL_MIN,
            data.space === null
              ? LABEL_MAX
              : Math.min(LABEL_MAX, data.space * s.transform[2] - 10),
          ),
        ),
      [data.space],
    ),
  );
  const height = useStore(
    (s: ReactFlowState) => s.nodeLookup.get(id)?.measured.height,
  );
  const copy = option !== undefined && live.compare ? live.compare : null;
  const values = copy
    ? copy.valuesFor(option!)
    : html
      ? live.valuesFor(artifact.id)
      : undefined;
  const frame = useFrameValues(values);
  const pageRef = useRef<HTMLDivElement>(null);

  const highlight: FrameHighlight = copy
    ? {
        hot: false,
        picked: copy.selected.includes(option!),
        tag: copy.selected.includes(option!)
          ? { kind: "", text: "Selected" }
          : null,
      }
    : live.highlight(artifact.id);
  const pins = copy
    ? []
    : live.pins.filter(
        (pin) =>
          pin.artifactId === artifact.id &&
          Math.abs(pin.width - w) <= 1 &&
          (h === null || pin.y <= h),
      );
  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (live.mode !== "comment") return;
    const box = event.currentTarget.getBoundingClientRect();
    // Unmeasured, as in a test: the frame's own pixels.
    const scale = box.width ? box.width / w : 1;
    live.comment({
      data,
      win: frame.ref.current?.contentWindow ?? null,
      page: pageRef.current,
      clientX: event.clientX,
      clientY: event.clientY,
      x: (event.clientX - box.left) / scale,
      y: (event.clientY - box.top) / scale,
      scale,
    });
  };

  const size = `${w} × ${Math.round(h ?? height ?? PAGE_HEIGHT)}`;
  const parts = labelParts(room, data.title, {
    ...(copy && !copy.selected.includes(option!)
      ? { use: `Use ${plainText(option!)}` }
      : {}),
    ...(highlight.tag ? { tag: highlight.tag.text } : {}),
    size,
  });
  const classes = [
    "frame",
    highlight.hot && "hot",
    highlight.picked && "picked",
    live.selected === id && "selected",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      <div
        className="frame-label"
        style={{ maxWidth: room }}
        title="Double-click to preview"
        onClick={() => live.select(id)}
        onDoubleClick={() => live.openPreview(id)}
      >
        <button
          className="frame-play nodrag"
          type="button"
          aria-label={`Preview ${data.title}`}
          title="Preview (P)"
          onClick={(event) => {
            event.stopPropagation();
            live.openPreview(id);
          }}
        >
          <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">
            <path d="M1 1.2v7.6L8 5z" fill="currentColor" />
          </svg>
        </button>
        <span className="frame-name">{data.title}</span>
        {parts.tag && highlight.tag && (
          <span className={`frame-tag ${highlight.tag.kind}`}>
            {highlight.tag.text}
          </span>
        )}
        {parts.size && <span className="frame-size">{size}</span>}
        {parts.use && copy && (
          <button
            className="frame-use nodrag"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              copy.onUse(option!);
            }}
          >
            Use {plainText(option!)}
          </button>
        )}
      </div>
      <div
        className="frame-body"
        style={
          h === null
            ? { width: w, minHeight: PAGE_HEIGHT }
            : { width: w, height: h }
        }
        onClick={onClick}
      >
        {!html ? (
          <div className="page" ref={pageRef}>
            <ArtifactDocument artifact={artifact} />
          </div>
        ) : mounted ? (
          <iframe
            ref={frame.ref}
            onLoad={frame.onLoad}
            title={data.title}
            tabIndex={-1}
            // No sandbox attribute: the server's CSP sandbox header isolates it.
            src={artifactViewUrl(live.token, artifact, {
              embed: artifact.kind === "diagram",
            })}
          />
        ) : (
          <div className="frame-placeholder">
            <span style={{ maxWidth: `calc(${w}px / var(--inv) - 16px)` }}>
              {data.title}
            </span>
          </div>
        )}
        {pins.map((pin) => (
          <PinMark key={pin.n} pin={pin} />
        ))}
      </div>
    </div>
  );
}
const NODE_TYPES = { frame: FrameNode, row: RowNode };

/** A fit to frames, asked for by the questions or the agent. */
export interface FitRequest {
  ids: string[];
  key: number;
  /**
   * Showing them on purpose: "best" goes to the workspace tab that holds
   * the first, "design" to the canvas. Otherwise the tab stays put.
   */
  reveal?: "best" | "design" | undefined;
}

export interface CanvasProps {
  token: string;
  session: SessionView;
  /** An html artifact's controls, with any unsaved preview. */
  valuesFor(artifactId: string): ControlValues;
  highlight(artifactId: string): FrameHighlight;
  compare: Comparison | null;
  /** Sent pins, and the one about to be. */
  pins: PinView[];
  /** What to show first; every frame when empty. */
  initial: string[];
  fit: FitRequest | null;
  onComment(pin: PlacedPin): void;
}

/**
 * The workspace as a canvas: every artifact a frame, laid out in a row
 * per question, that people pan, zoom, arrange, preview at full size and
 * pin comments to.
 */
export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Board {...props} />
    </ReactFlowProvider>
  );
}

function Board({
  token,
  session,
  valuesFor,
  highlight,
  compare,
  pins,
  initial,
  fit,
  onComment,
}: CanvasProps) {
  const flow = useReactFlow<CanvasNode>();
  const store = useStoreApi<CanvasNode>();
  const stage = useRef<HTMLElement>(null);
  const [mode, setMode] = useState<Mode>("move");
  const [selected, setSelected] = useState<string | null>(null);
  const [run, setRun] = useState<{ id: string; device: Device } | null>(null);
  const [full, setFull] = useState(false);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  // Frames this page moved, until the hub's copy says the same.
  const [moved, setMoved] = useState<Record<string, FramePosition>>({});

  const heights = Object.fromEntries(
    nodes
      .filter((node) => node.type === "frame" && node.measured?.height)
      .map((node) => [node.id, Math.round(node.measured!.height!)]),
  );
  const heightsKey = JSON.stringify(heights);
  const positions = { ...session.positions, ...moved };
  const positionsKey = JSON.stringify(positions);
  useEffect(() => {
    setMoved((current) => {
      const left = Object.entries(current).filter(([id, at]) => {
        const saved = session.positions[id];
        return !saved || saved.x !== at.x || saved.y !== at.y;
      });
      return left.length === Object.keys(current).length
        ? current
        : Object.fromEntries(left);
    });
  }, [JSON.stringify(session.positions)]);

  const layout = useMemo(
    () =>
      layoutCanvas(
        session,
        positions,
        heights,
        compare && { question: compare.question, artifact: compare.artifact },
      ),
    [
      session.artifacts,
      session.questions,
      positionsKey,
      heightsKey,
      compare?.question.id,
      compare?.artifact,
    ],
  );
  useEffect(() => {
    const boxes = [...layout.frames, ...(compare ? layout.copies : [])].map(
      (frame) => ({
        id: frame.id,
        x: frame.x,
        y: frame.y,
        w: frame.w,
        h: frame.h ?? heights[frame.id] ?? PAGE_HEIGHT,
      }),
    );
    const space = labelSpace(boxes);
    const next: CanvasNode[] = [
      ...layout.rows.map((row): RowNodeType => ({
        id: row.id,
        type: "row",
        position: { x: 0, y: row.y },
        data: { title: row.title, note: row.note },
        draggable: false,
        selectable: false,
        focusable: false,
      })),
      ...layout.frames.map((frame): FrameNodeType => ({
        id: frame.id,
        type: "frame",
        position: { x: frame.x, y: frame.y },
        data: {
          artifact: frame.artifact,
          title: frame.artifact.title,
          w: frame.w,
          h: frame.h,
          space: space[frame.id] ?? null,
        },
        dragHandle: ".frame-label",
      })),
      ...(compare
        ? layout.copies.map((copy): FrameNodeType => ({
            id: copy.id,
            type: "frame",
            position: { x: copy.x, y: copy.y },
            data: {
              artifact: compare.artifact,
              title: `${compare.artifact.title.replace(DEVICE_SUFFIX, "")} · ${copy.option}`,
              w: copy.w,
              h: copy.h,
              option: copy.option,
              space: space[copy.id] ?? null,
            },
            dragHandle: ".frame-label",
          }))
        : []),
    ];
    // Keep what React Flow measured, and a frame mid-drag where the pointer has it.
    setNodes((current) => {
      const was = new Map(current.map((node) => [node.id, node]));
      return next.map((node) => {
        const old = was.get(node.id);
        if (!old) return node;
        return {
          ...node,
          measured: old.measured,
          ...(old.dragging ? { position: old.position, dragging: true } : {}),
        } as CanvasNode;
      });
    });
  }, [layout, compare]);

  const fitTo = useCallback(
    (ids: string[], duration = fitMs()) => {
      let tries = 0;
      // New frames are measured a frame or two after they mount.
      const attempt = () => {
        const ready = ids.every(
          (id) => flow.getInternalNode(id)?.measured.width,
        );
        if (!ready && tries++ < 30) {
          requestAnimationFrame(attempt);
          return;
        }
        // A canvas with no size yet (hidden, or a test) has nothing to fit into.
        if (!store.getState().width) return;
        const known = ids.filter((id) => flow.getInternalNode(id));
        void flow.fitView({
          ...(known.length ? { nodes: known.map((id) => ({ id })) } : {}),
          // A phone's canvas is small: the frames in hand get most of it.
          padding: window.matchMedia?.("(max-width: 620px)").matches
            ? 0.08
            : 0.2,
          duration,
          maxZoom: 0.7,
        });
      };
      requestAnimationFrame(attempt);
    },
    [flow, store],
  );
  // Start on what's in hand, once the frames are measured.
  const initialized = useNodesInitialized();
  const started = useRef(false);
  useEffect(() => {
    if (!initialized || started.current || !nodes.length) return;
    started.current = true;
    fitTo(initial, 0);
  }, [initialized, nodes.length]);
  useEffect(() => {
    if (fit && started.current) fitTo(fit.ids);
  }, [fit?.key]);

  const frameData = (id: string) =>
    nodes.find(
      (node): node is FrameNodeType => node.id === id && node.type === "frame",
    )?.data;
  const openPreview = (id: string) => {
    const data = frameData(id);
    if (!data) return;
    setSelected(id);
    setRun({ id, device: deviceFor(data.w) });
    setFull(false);
  };
  const closePreview = () => {
    setRun(null);
    setFull(false);
  };
  const place = (data: FrameData, spot: Placed) => {
    setMode("move");
    // The chat has to be in view to write the comment.
    setFull(false);
    onComment({ ...spot, artifactId: data.artifact.id, title: data.title });
  };

  // Esc backs out one level: comment mode, then full screen, then the preview.
  const escape = useRef<() => boolean>(() => false);
  escape.current = () => {
    if (mode === "comment") setMode("move");
    else if (full) setFull(false);
    else if (run) closePreview();
    else return false;
    return true;
  };
  useFrameEscape(() => escape.current());
  const openSelected = useRef(() => {});
  openSelected.current = () => {
    if (selected && !run) openPreview(selected);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.defaultPrevented || target.closest?.(".chat, .switcher"))
        return;
      if (event.key === "Escape") {
        if (escape.current()) event.preventDefault();
        return;
      }
      const typing =
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
        target.isContentEditable;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target.tagName === "BUTTON" && event.key === " ") return;
      const key = event.key.toLowerCase();
      if (key === "c") setMode("comment");
      if (key === "v" && !event.shiftKey) setMode("move");
      if (key === "p" || (event.key === " " && event.shiftKey)) {
        event.preventDefault();
        openSelected.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("previewing", Boolean(run));
    document.documentElement.classList.toggle(
      "previewing-full",
      Boolean(run && full),
    );
    return () =>
      document.documentElement.classList.remove(
        "previewing",
        "previewing-full",
      );
  }, [run, full]);

  const live: Live = {
    token,
    mode,
    selected,
    pins,
    compare,
    valuesFor,
    highlight,
    select: setSelected,
    openPreview,
    comment: ({ data, win, page, clientX, clientY, x, y, scale }) =>
      void (async () => {
        let spot: Spot | null = null;
        if (win) spot = await pickIn(win, x, y);
        else if (page) spot = spotInDocument(page, clientX, clientY, scale);
        place(data, {
          ...(spot ?? { element: "page", selector: null, fx: 0, fy: 0, x, y }),
          width: data.w,
        });
      })(),
  };

  const previewed = run ? frameData(run.id) : undefined;
  const previewCopy =
    previewed?.option !== undefined && compare ? compare : null;
  return (
    <LiveContext.Provider value={live}>
      <section
        className={`stage${mode === "comment" ? " commenting" : ""}`}
        ref={stage}
        aria-label="Canvas"
      >
        <ReactFlow<CanvasNode>
          nodes={nodes}
          onNodesChange={(changes: NodeChange<CanvasNode>[]) =>
            setNodes((current) => applyNodeChanges(changes, current))
          }
          onNodeDragStop={(_event, node) => {
            if (node.type !== "frame" || node.data.option !== undefined) return;
            const at = {
              x: Math.round(node.position.x),
              y: Math.round(node.position.y),
            };
            setMoved((current) => ({ ...current, [node.id]: at }));
            void fetch(`/api/browser/${token}/frames/${node.id}/position`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(at),
            });
          }}
          nodeTypes={NODE_TYPES}
          minZoom={0.04}
          maxZoom={2}
          panOnScroll
          elementsSelectable={false}
          nodesConnectable={false}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          deleteKeyCode={null}
          onPaneClick={() => setSelected(null)}
          attributionPosition="bottom-right"
        >
          <InvZoom stage={stage} />
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.4}
            color="#c4c9d1"
          />
          <Controls
            position="bottom-left"
            showInteractive={false}
            fitViewOptions={{ padding: 0.12, duration: fitMs() }}
          />
          <MiniMap<CanvasNode>
            position="top-right"
            style={{ width: 150, height: 100 }}
            pannable
            zoomable
            ariaLabel="Canvas overview"
            nodeColor={(node) =>
              node.type === "row"
                ? "transparent"
                : node.data.artifact.format === "html"
                  ? "#d9dee6"
                  : "#ffffff"
            }
            nodeStrokeColor={(node) =>
              node.type === "row" ? "transparent" : "#b7bec9"
            }
            nodeBorderRadius={2}
            maskColor="rgb(238 240 243 / 0.72)"
          />
          <Panel position="bottom-center" className="toolbar-panel">
            <div className="toolbar" role="toolbar" aria-label="Canvas tools">
              <button
                type="button"
                className={`tool${mode === "move" ? " on" : ""}`}
                aria-pressed={mode === "move"}
                onClick={() => setMode("move")}
                title="Move (V)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                >
                  <path
                    d="M2.5 1.5 11 7.2l-3.9.6 2.2 4-1.6.8-2.2-4-2.9 2.7z"
                    fill="currentColor"
                  />
                </svg>
                <span className="tool-text">Move</span>
                <kbd>V</kbd>
              </button>
              <button
                type="button"
                className={`tool${mode === "comment" ? " on" : ""}`}
                aria-pressed={mode === "comment"}
                onClick={() => setMode(mode === "comment" ? "move" : "comment")}
                title="Comment (C)"
              >
                <CommentIcon />
                <span className="tool-text">Comment</span>
                <kbd>C</kbd>
              </button>
              <span className="tool-sep" aria-hidden="true" />
              <button
                type="button"
                className="tool"
                onClick={() =>
                  void flow.fitView({ padding: 0.1, duration: fitMs() })
                }
                title="Fit all"
              >
                <FitIcon />
                <span className="tool-text">Fit all</span>
              </button>
              <ZoomReadout />
            </div>
          </Panel>
          {mode === "comment" && !run && (
            <Panel position="top-center">
              <span className="comment-hint">
                Click a frame to pin a comment · Esc to cancel
              </span>
            </Panel>
          )}
        </ReactFlow>
        {run && previewed && (
          <Preview
            token={token}
            artifact={previewed.artifact}
            title={previewed.title}
            values={
              previewed.artifact.format !== "html"
                ? undefined
                : previewCopy
                  ? previewCopy.valuesFor(previewed.option!)
                  : valuesFor(previewed.artifact.id)
            }
            pins={
              previewCopy
                ? []
                : pins.filter((pin) => pin.artifactId === previewed.artifact.id)
            }
            device={run.device}
            setDevice={(device) => setRun({ ...run, device })}
            full={full}
            setFull={setFull}
            commenting={mode === "comment"}
            setCommenting={(on) => setMode(on ? "comment" : "move")}
            onClose={closePreview}
            onPlace={(spot) => place(previewed, spot)}
          />
        )}
      </section>
    </LiveContext.Provider>
  );
}
