import type { ComponentType } from "react";
import type { InboxItem, InboxKind } from "../../shared/inbox.js";
import { AutomationDown } from "./automations/AutomationDown.js";
import { AutomationsSection } from "./automations/AutomationsSection.js";
import { CiFailedDetail, PrsReadyDetail } from "./github/InboxDetails.js";
import { PrPage } from "./github/PrPage.js";
import { PullRequests } from "./github/PullRequests.js";

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

export const projectSections: ProjectSection[] = [
  {
    id: "automations",
    title: "Automations & machines",
    column: "side",
    Component: AutomationsSection,
  },
  {
    id: "prs",
    title: "Pull requests",
    column: "main",
    Component: PullRequests,
  },
];

export const inboxDetails: Partial<Record<InboxKind, InboxDetail>> = {
  automation_down: AutomationDown,
  ci_failed: CiFailedDetail,
  prs_ready: PrsReadyDetail,
};

/** Extra full pages under /p/<projectId>/…, matched in order. */
export interface ProjectRoute {
  /** Matches the path after /p/<projectId>/, e.g. /^pr\/(\d+)$/. */
  pattern: RegExp;
  Component: ComponentType<{ projectId: string; match: RegExpMatchArray }>;
}

export const projectRoutes: ProjectRoute[] = [
  { pattern: /^pr\/(\d+)$/, Component: PrPage },
];
