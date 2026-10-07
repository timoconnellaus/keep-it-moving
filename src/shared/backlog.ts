import { z } from "zod";

export const backlogStatuses = [
  "todo",
  "in_progress",
  "done",
  "cancelled",
] as const;
export type BacklogStatus = (typeof backlogStatuses)[number];

export const backlogSources = ["github", "script", "none"] as const;
export type BacklogSource = (typeof backlogSources)[number];

/** Bodies are context for agents, not a copy of the source; longer ones are cut. */
export const BODY_LIMIT = 4000;

/** Scripts often print null for a missing field; treat it as absent. */
const optional = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

/** A date (2026-10-24) or a timestamp, kept as the date. */
const IsoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}/, "Expected an ISO date like 2026-10-24")
  .transform((value) => value.slice(0, 10));

export const BacklogItemInputSchema = z.object({
  /** The source's own id: an issue number, a Linear identifier like ENG-42. */
  sourceId: z.coerce.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  status: z.enum(backlogStatuses),
  url: optional(z.string().trim().url().max(2000)),
  /** The milestone's sourceId or name. */
  milestone: optional(z.coerce.string().trim().min(1).max(200)),
  /** Lower comes first: 0 is the most urgent. */
  priority: optional(z.number().finite()),
  /** The source's own order, when it has one; lower comes first. */
  order: optional(z.number().finite()),
  assignee: optional(z.string().trim().max(200)),
  labels: optional(z.array(z.string().trim().min(1).max(100)).max(50)),
  body: optional(z.string().transform((body) => body.slice(0, BODY_LIMIT))),
});

export const BacklogMilestoneInputSchema = z.object({
  sourceId: z.coerce.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  due: optional(IsoDate),
  url: optional(z.string().trim().url().max(2000)),
});

/** What a project's sync script prints on stdout, and what GitHub sync produces. */
export const BacklogSyncOutputSchema = z.object({
  items: z.array(BacklogItemInputSchema).max(5000),
  milestones: optional(z.array(BacklogMilestoneInputSchema).max(500)),
});

export type BacklogItemInput = z.infer<typeof BacklogItemInputSchema>;
export type BacklogMilestoneInput = z.infer<typeof BacklogMilestoneInputSchema>;
export type BacklogSyncOutput = z.infer<typeof BacklogSyncOutputSchema>;

export interface BacklogItemView {
  sourceId: string;
  title: string;
  status: BacklogStatus;
  url: string | null;
  milestone: string | null;
  priority: number | null;
  order: number | null;
  assignee: string | null;
  labels: string[];
  body: string | null;
  /** "local" items were added here, not read from the source. */
  origin: "source" | "local";
  updatedAt: string;
}

export interface MilestoneView {
  sourceId: string;
  name: string;
  due: string | null;
  url: string | null;
  /** Defined in the workbench rather than read from the source. */
  manual: boolean;
  done: number;
  inProgress: number;
  /** Items in the milestone, not counting cancelled ones. */
  total: number;
}

export interface BacklogSettingsView {
  /** The configured source, or the default: GitHub for a github.com project. */
  source: BacklogSource;
  configured: boolean;
  hasScript: boolean;
  autoWrite: boolean;
  /** A milestone sourceId or name that wins over the automatic choice. */
  milestoneOverride: string | null;
  syncedAt: string | null;
  syncError: string | null;
}

export interface BacklogCounts {
  todo: number;
  inProgress: number;
  done: number;
  total: number;
}

/** A project's backlog as the project page shows it. */
export interface ProjectBacklogView {
  project: { id: string; key: string; name: string };
  settings: BacklogSettingsView;
  milestone: MilestoneView | null;
  /** In progress first, then todo, in backlog order. */
  upNext: BacklogItemView[];
  counts: BacklogCounts;
  /** The CLI command that syncs this project, for script sources. */
  syncCommand: string;
}

export const followUpStates = [
  "open",
  "accepted",
  "dismissed",
  "started",
] as const;
export type FollowUpState = (typeof followUpStates)[number];

/** Something a finished session left undone, waiting for Tim to triage. */
export interface FollowUpView {
  id: string;
  projectId: string;
  agentSessionId: string | null;
  text: string;
  state: FollowUpState;
  /** The backlog item it became, once accepted. */
  backlogSourceId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export const FollowUpsInputSchema = z.object({
  /** The project's normalised remote, e.g. github.com/owner/repo. */
  projectKey: z.string().trim().min(1).max(300),
  agentSessionId: optional(z.string().trim().min(1).max(200)),
  items: z.array(z.string().trim().max(2000)).max(50),
});

export const FollowUpActionSchema = z.object({
  action: z.enum(["accept", "dismiss", "start"]),
});
