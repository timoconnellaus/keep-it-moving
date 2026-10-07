import { sessionsFeature } from "./sessions.js";
import { backlogFeature } from "./backlog.js";
import { githubFeature } from "./github/index.js";
import { automations } from "./automations.js";
import type { Feature, FeatureContext } from "./types.js";

export type { Feature, FeatureContext } from "./types.js";

/** Every feature, in inbox order. Each feature adds one line here. */
export function allFeatures(ctx: FeatureContext): Feature[] {
  return [
    sessionsFeature(ctx),
    backlogFeature(ctx),
    githubFeature(ctx),
    automations(ctx),
  ];
}
