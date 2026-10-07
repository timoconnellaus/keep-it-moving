import { sessionsFeature } from "./sessions.js";
import { backlogFeature } from "./backlog.js";
import { githubFeature } from "./github/index.js";
import { automations } from "./automations.js";
import { keysFeature } from "./keys.js";
import { summariesFeature } from "./summaries.js";
import type { Feature, FeatureContext } from "./types.js";

export type { Feature, FeatureContext } from "./types.js";

/** Every feature, in inbox order. Each feature adds one line here. */
export function allFeatures(ctx: FeatureContext): Feature[] {
  const features: Feature[] = [
    sessionsFeature(ctx),
    backlogFeature(ctx),
    githubFeature(ctx),
    automations(ctx),
    keysFeature(ctx),
    summariesFeature(ctx, () => features),
  ];
  return features;
}
