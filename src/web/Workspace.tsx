import { useEffect, useRef, useState } from "react";
import type { ControlValues } from "../shared/bindings.js";
import type {
  ArtifactView,
  DesignType,
  PinView,
  SessionView,
} from "../shared/schema.js";
import { artifactViewUrl, frameSize } from "../shared/workspace.js";
import {
  Canvas,
  type Comparison,
  type FitRequest,
  type FrameHighlight,
  type PlacedPin,
} from "./Canvas.js";
import { useFrameEscape } from "./frames.js";
import { DEVICES, deviceFor, Preview, type Device } from "./Preview.js";

/**
 * The workspace's tabs: the plan and documents to read, html pages to use
 * at a device's width, the design canvas of every visual artifact, and
 * the system designs (data models, architecture, flows, APIs).
 */
export const TABS = {
  document: { label: "Document" },
  html: { label: "HTML" },
  design: { label: "Design" },
  system: { label: "System" },
} as const;
export type Tab = keyof typeof TABS;

/**
 * The tab that shows an artifact by itself: documents are only on the
 * Document tab; html pages are on HTML and the Design canvas, diagrams only
 * on the canvas, and system designs only on System.
 */
export function tabFor(artifact: ArtifactView): Tab {
  if (artifact.kind === "design") return "system";
  if (artifact.kind === "diagram") return "design";
  if (artifact.format === "html") return "html";
  if (artifact.format === "markdown" || artifact.format === "text")
    return "document";
  return "design";
}

const TAB_KEY = "kim.workspaceTab";
function rememberedTab(): Tab | null {
  try {
    const tab = localStorage.getItem(TAB_KEY);
    return tab && tab in TABS ? (tab as Tab) : null;
  } catch {
    return null;
  }
}
function rememberTab(tab: Tab) {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // A private window: the tab is remembered for this page only.
  }
}

export function Workspace({
  token,
  session,
  valuesFor,
  highlight,
  compare,
  pins,
  initial,
  fit,
  onComment,
}: {
  token: string;
  session: SessionView;
  valuesFor(artifactId: string): ControlValues;
  highlight(artifactId: string): FrameHighlight;
  compare: Comparison | null;
  pins: PinView[];
  /** What's in hand, most relevant first. */
  initial: string[];
  fit: FitRequest | null;
  onComment(pin: PlacedPin): void;
}) {
  const inTab = (tab: Tab) =>
    session.artifacts.filter((artifact) =>
      tab === "design"
        ? tabFor(artifact) === "design" || tabFor(artifact) === "html"
        : tabFor(artifact) === tab,
    );
  const tabs = (Object.keys(TABS) as Tab[]).filter(
    (tab) => inTab(tab).length > 0,
  );
  const [chosenTab, setChosenTab] = useState<Tab>(
    () => rememberedTab() ?? "design",
  );
  const tab = tabs.includes(chosenTab)
    ? chosenTab
    : tabs.includes("design")
      ? "design"
      : tabs[0]!;
  const chooseTab = (next: Tab) => {
    setChosenTab(next);
    rememberTab(next);
  };
  // The artifact each tab shows; until someone picks one, what's in hand.
  const [chosen, setChosen] = useState<Partial<Record<Tab, string>>>({});
  const shownIn = (target: Tab): ArtifactView | undefined => {
    const list = inTab(target);
    return (
      list.find((artifact) => artifact.id === chosen[target]) ??
      initial
        .map((id) => list.find((artifact) => artifact.id === id))
        .find(Boolean) ??
      list[0]
    );
  };

  // A request to show artifacts: the canvas fits them; a tab that shows one
  // at a time shows the first it holds. Showing something on purpose goes
  // to the tab that holds it.
  const lastFit = useRef(fit?.key);
  useEffect(() => {
    if (!fit || fit.key === lastFit.current) return;
    lastFit.current = fit.key;
    if (fit.reveal === "design") return setChosenTab("design");
    const owner = (id: string) => {
      const artifact = session.artifacts.find((item) => item.id === id);
      return artifact ? tabFor(artifact) : null;
    };
    // The canvas fits whatever it holds; the other tabs show one at a time.
    if (
      tab === "design" &&
      fit.ids.some((id) => ["design", "html"].includes(owner(id) ?? ""))
    )
      return;
    const here =
      tab === "design" ? undefined : fit.ids.find((id) => owner(id) === tab);
    if (here) return setChosen((current) => ({ ...current, [tab]: here }));
    if (fit.reveal !== "best") return;
    const first = fit.ids.find((id) => owner(id));
    if (!first) return;
    const target = owner(first)!;
    setChosenTab(target);
    if (target !== "design")
      setChosen((current) => ({ ...current, [target]: first }));
  }, [fit?.key]);

  const shown = tab === "design" ? undefined : shownIn(tab);
  return (
    <section className="stage-tabs" aria-label="Workspace">
      <div className="tabs" role="tablist" aria-label="Workspace views">
        {tabs.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`tab-${key}`}
            aria-selected={key === tab}
            aria-controls="workspace-panel"
            className={key === tab ? "on" : ""}
            onClick={() => chooseTab(key)}
          >
            {TABS[key].label}
            <span className="count">{inTab(key).length}</span>
          </button>
        ))}
      </div>
      <div
        className="tab-panel"
        id="workspace-panel"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
      >
        {tab === "design" ? (
          <Canvas
            token={token}
            session={{ ...session, artifacts: inTab("design") }}
            valuesFor={valuesFor}
            highlight={highlight}
            compare={compare}
            pins={pins}
            initial={initial}
            fit={fit}
            onComment={onComment}
          />
        ) : tab === "system" ? (
          shown && (
            <SystemPane
              token={token}
              artifact={shown}
              designs={inTab("system")}
              onChoose={(id) =>
                setChosen((current) => ({ ...current, system: id }))
              }
              pins={pins.filter((pin) => pin.artifactId === shown.id)}
              onComment={onComment}
            />
          )
        ) : (
          shown && (
            <ArtifactPane
              key={tab}
              token={token}
              artifact={shown}
              choices={inTab(tab)}
              onChoose={(id) =>
                setChosen((current) => ({ ...current, [tab]: id }))
              }
              values={shown.format === "html" ? valuesFor(shown.id) : undefined}
              pins={pins.filter((pin) => pin.artifactId === shown.id)}
              onComment={onComment}
            />
          )
        )}
      </div>
    </section>
  );
}

/** Each design type's heading in the System tab's list, in list order. */
export const DESIGN_TYPE_LABELS: Record<DesignType, string> = {
  "data-model": "Data model",
  architecture: "Architecture",
  "data-flow": "Data flow",
  sequence: "Sequence",
  state: "State machine",
  api: "API contract",
};

/** What the viewer counted against the repo copy. */
interface DesignChanges {
  added: number;
  changed: number;
  removed: number;
}

const COMPARE_KEY = "kim.compareWithRepo";
function rememberedCompare(): boolean {
  try {
    return localStorage.getItem(COMPARE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Where an artifact stands with the repo: pulled from it, and whether it goes back. */
export function RepoBadges({ artifact }: { artifact: ArtifactView }) {
  return (
    <span className="repo-badges">
      {artifact.repo && (
        <span className="repo-badge from" title={artifact.repo.path}>
          From repo
        </span>
      )}
      <span
        className={`repo-badge ${artifact.keep ? "keep" : "local"}`}
        title={
          artifact.keep
            ? `Written to ${artifact.repo?.path ?? ".kim/"} when the interview stops`
            : "Stays in this interview; ask the agent to keep it"
        }
      >
        {artifact.keep ? "Saves to repo" : "Interview only"}
      </span>
    </span>
  );
}

/**
 * The System tab: the interview's designs listed by type, and the chosen
 * one drawn by the design viewer, compared with its repo copy.
 */
function SystemPane({
  token,
  artifact,
  designs,
  onChoose,
  pins,
  onComment,
}: {
  token: string;
  artifact: ArtifactView;
  designs: ArtifactView[];
  onChoose(id: string): void;
  pins: PinView[];
  onComment(pin: PlacedPin): void;
}) {
  const frames = useRef<HTMLDivElement>(null);
  const [compare, setCompare] = useState(rememberedCompare);
  const [changes, setChanges] = useState<{
    key: string;
    counts: DesignChanges;
  } | null>(null);
  const key = `${artifact.id}:${artifact.revision}`;
  const compareRef = useRef(compare);
  compareRef.current = compare;
  const frameWindow = () =>
    frames.current?.querySelector("iframe")?.contentWindow ?? null;
  // The viewer compares by default; it reports after each draw, which is
  // when a frame that has just loaded learns comparing is off.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } & Partial<DesignChanges>;
      if (data?.type !== "kim-design-changes" || event.source !== frameWindow())
        return;
      setChanges({
        key,
        counts: {
          added: Number(data.added) || 0,
          changed: Number(data.changed) || 0,
          removed: Number(data.removed) || 0,
        },
      });
      if (!compareRef.current)
        frameWindow()?.postMessage({ type: "kim-compare", on: false }, "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [key]);
  const toggleCompare = (on: boolean) => {
    setCompare(on);
    try {
      localStorage.setItem(COMPARE_KEY, on ? "on" : "off");
    } catch {
      // A private window: remembered for this page only.
    }
    frameWindow()?.postMessage({ type: "kim-compare", on }, "*");
  };
  const counts = changes?.key === key ? changes.counts : null;
  const total = counts ? counts.added + counts.changed + counts.removed : 0;
  const groups = (Object.keys(DESIGN_TYPE_LABELS) as DesignType[])
    .map((type) => ({
      type,
      items: designs.filter((design) => design.designType === type),
    }))
    .filter((group) => group.items.length);

  const tools = artifact.repo && (
    <>
      {counts && (
        <span className={`design-changes${total ? " some" : ""}`}>
          {total
            ? `${total} change${total === 1 ? "" : "s"}`
            : "Same as the repo"}
        </span>
      )}
      <label className="pbtn compare-toggle" title={artifact.repo.path}>
        <input
          type="checkbox"
          checked={compare}
          onChange={(event) => toggleCompare(event.target.checked)}
        />
        <span className="ptext">Compare with repo</span>
      </label>
    </>
  );
  return (
    <div className="system-pane">
      <nav className="design-list" aria-label="Designs">
        {groups.map((group) => (
          <section key={group.type}>
            <h3>{DESIGN_TYPE_LABELS[group.type]}</h3>
            {group.items.map((design) => (
              <button
                key={design.id}
                type="button"
                className={design.id === artifact.id ? "on" : ""}
                aria-current={design.id === artifact.id || undefined}
                onClick={() => onChoose(design.id)}
              >
                <b>{design.title}</b>
                {design.repo && (
                  <small className="design-path">{design.repo.path}</small>
                )}
                <RepoBadges artifact={design} />
              </button>
            ))}
          </section>
        ))}
      </nav>
      <div className="system-frame" ref={frames}>
        <ArtifactPane
          token={token}
          artifact={artifact}
          choices={designs}
          onChoose={onChoose}
          values={{}}
          pins={pins}
          onComment={onComment}
          extraTools={tools || undefined}
        />
      </div>
    </div>
  );
}

/** One artifact filling the tab, with a choice of the tab's others. */
function ArtifactPane({
  token,
  artifact,
  choices,
  onChoose,
  values,
  pins,
  onComment,
  extraTools,
}: {
  token: string;
  artifact: ArtifactView;
  choices: ArtifactView[];
  onChoose(id: string): void;
  values: ControlValues | undefined;
  pins: PinView[];
  onComment(pin: PlacedPin): void;
  extraTools?: React.ReactNode;
}) {
  const html = artifact.format === "html";
  // A phone mockup opens on a phone; the user's pick holds until another artifact.
  const natural = deviceFor(frameSize(artifact).w);
  const [view, setView] = useState<{
    id: string;
    device: Device;
    landscape: boolean;
  }>({ id: artifact.id, device: natural, landscape: false });
  const { device, landscape } =
    view.id === artifact.id ? view : { device: natural, landscape: false };
  const setDevice = (next: Device) =>
    setView({ id: artifact.id, device: next, landscape: false });
  const [full, setFull] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Esc backs out one level: comment mode, then full screen.
  const escape = useRef<() => boolean>(() => false);
  escape.current = () => {
    if (commenting) setCommenting(false);
    else if (full) setFull(false);
    else return false;
    return true;
  };
  useFrameEscape(() => escape.current());
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
      if (event.key.toLowerCase() === "c") setCommenting((on) => !on);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("previewing-full", full);
    return () => document.documentElement.classList.remove("previewing-full");
  }, [full]);

  const picker =
    choices.length > 1 ? (
      <select
        className="pane-picker"
        aria-label={html ? "Page" : "Document"}
        value={artifact.id}
        onChange={(event) => onChoose(event.target.value)}
      >
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.title}
          </option>
        ))}
      </select>
    ) : undefined;
  const rotatable = html && DEVICES[device].h > 0;
  const tools = html && (
    <>
      {extraTools}
      {rotatable && (
        <button
          type="button"
          className={`pbtn${landscape ? " on" : ""}`}
          aria-pressed={landscape}
          title="Rotate"
          onClick={() =>
            setView({ id: artifact.id, device, landscape: !landscape })
          }
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect
              x="1.5"
              y="5.5"
              width="11"
              height="7"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="M3 3.5A4 4 0 0 1 9.5 2.2M9.6.6v1.9H7.7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="ptext">Rotate</span>
        </button>
      )}
      <button
        type="button"
        className="pbtn"
        title="Reload"
        aria-label="Reload"
        onClick={() => setReloadKey((key) => key + 1)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M12 7a5 5 0 1 1-1.5-3.6M12 1.5v3h-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <a
        className="pbtn"
        href={artifactViewUrl(token, artifact)}
        target="_blank"
        rel="noreferrer"
        title="Open in a new tab"
        aria-label="Open in a new tab"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M8 1.5h4.5V6M12.5 1.5 6.5 7.5M11 9v3.5H1.5V3H5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </a>
    </>
  );
  return (
    <Preview
      token={token}
      artifact={artifact}
      title={artifact.title}
      values={values}
      pins={pins}
      device={device}
      setDevice={setDevice}
      full={full}
      setFull={setFull}
      commenting={commenting}
      setCommenting={setCommenting}
      onPlace={(spot) => {
        setCommenting(false);
        // The chat has to be in view to write the comment.
        setFull(false);
        onComment({ ...spot, artifactId: artifact.id, title: artifact.title });
      }}
      embedded
      picker={picker}
      tools={tools || undefined}
      landscape={landscape}
      reloadKey={reloadKey}
    />
  );
}
