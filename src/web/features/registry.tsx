import type { ComponentType } from "react";
import type { InboxItem, InboxKind } from "../../shared/inbox.js";

/** A section of the project page, in order. Each feature adds its own. */
export interface ProjectSection {
  id: string;
  title: string;
  /** "main" sections stack in the wide column, "side" in the narrow one. */
  column: "main" | "side";
  Component: ComponentType<{ projectId: string }>;
}

/** How each kind of inbox item shows when selected; a fallback shows the brief. */
export type InboxDetail = ComponentType<{
  item: InboxItem;
  /** Mark it handled and move to the next item. */
  done: () => void;
}>;

export const projectSections: ProjectSection[] = [];

export const inboxDetails: Partial<Record<InboxKind, InboxDetail>> = {};

/** Extra full pages under /p/<projectId>/…, matched in order. */
export interface ProjectRoute {
  /** Matches the path after /p/<projectId>/, e.g. /^pr\/(\d+)$/. */
  pattern: RegExp;
  Component: ComponentType<{ projectId: string; match: RegExpMatchArray }>;
}

export const projectRoutes: ProjectRoute[] = [];
