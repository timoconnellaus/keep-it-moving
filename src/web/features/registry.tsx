import type { ComponentType } from "react";
import type { InboxItem, InboxKind } from "../../shared/inbox.js";
import { AutomationDown } from "./automations/AutomationDown.js";
import { AutomationsSection } from "./automations/AutomationsSection.js";
import { CiFailedDetail, PrsReadyDetail } from "./github/InboxDetails.js";
import { PrPage } from "./github/PrPage.js";
import { PullRequests } from "./github/PullRequests.js";
import { FollowUpsDetail, FollowUpsSection } from "./backlog/FollowUps.js";
import { MilestoneSection } from "./backlog/Milestone.js";
import { UpNextSection } from "./backlog/UpNext.js";
import { NeedsYouDetail, RequestDetail } from "./sessions/details.js";
import { SessionsSection } from "./sessions/SessionsSection.js";

/** A section of the project page, in order. Each feature adds its own. */
export interface ProjectSection {
  id: string;
  title: string;
  /** "main" sections stack in the wide column, "side" in the narrow one. */
  column: "main" | "side";
  /** The section draws its own heading, so the page leaves its title out. */
  ownHeader?: boolean;
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
    id: "milestone",
    title: "Milestone",
    column: "main",
    ownHeader: true,
    Component: MilestoneSection,
  },
  {
    id: "sessions",
    title: "Sessions",
    column: "main",
    Component: SessionsSection,
  },
  {
    id: "prs",
    title: "Pull requests",
    column: "main",
    ownHeader: true,
    Component: PullRequests,
  },
  {
    id: "up-next",
    title: "Up next",
    column: "side",
    ownHeader: true,
    Component: UpNextSection,
  },
  {
    id: "follow-ups",
    title: "Follow-ups",
    column: "side",
    ownHeader: true,
    Component: FollowUpsSection,
  },
  {
    id: "automations",
    title: "Automations & machines",
    column: "side",
    Component: AutomationsSection,
  },
];

export const inboxDetails: Partial<Record<InboxKind, InboxDetail>> = {
  request: RequestDetail,
  needs_you: NeedsYouDetail,
  automation_down: AutomationDown,
  ci_failed: CiFailedDetail,
  prs_ready: PrsReadyDetail,
  follow_ups: FollowUpsDetail,
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
