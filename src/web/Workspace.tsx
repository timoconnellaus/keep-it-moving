import { useEffect, useRef, useState } from "react";
import type { ControlValues } from "../shared/bindings.js";
import type { ArtifactView, PinView, SessionView } from "../shared/schema.js";
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
 * at a device's width, and the design canvas of every artifact.
 */
export const TABS = {
  document: { label: "Document" },
  html: { label: "HTML" },
  design: { label: "Design" },
} as const;
export type Tab = keyof typeof TABS;

/**
 * The tab that shows an artifact by itself: documents are only on the
 * Document tab; html pages are on HTML and the Design canvas, diagrams only
 * on the canvas.
 */
export function tabFor(artifact: ArtifactView): Tab {
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
        ? tabFor(artifact) !== "document"
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
      fit.ids.some((id) => (owner(id) ?? "document") !== "document")
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

/** One artifact filling the tab, with a choice of the tab's others. */
function ArtifactPane({
  token,
  artifact,
  choices,
  onChoose,
  values,
  pins,
  onComment,
}: {
  token: string;
  artifact: ArtifactView;
  choices: ArtifactView[];
  onChoose(id: string): void;
  values: ControlValues | undefined;
  pins: PinView[];
  onComment(pin: PlacedPin): void;
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
