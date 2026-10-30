import type {
  ArtifactView,
  FramePosition,
  QuestionView,
  SessionView,
} from "../shared/schema.js";
import { frameSize, PAGE_HEIGHT, type FrameSize } from "../shared/workspace.js";

/** Space between frames in a row, and between rows, in canvas pixels. */
export const COL_GAP = 120;
export const ROW_GAP = 700;
// Frame sizes live with the server's too, which tells agents what to fetch.
export {
  frameSize,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  type FrameSize,
} from "../shared/workspace.js";

/** The artifacts a question is about: its options' frames in option order, then its own. */
export function questionArtifacts(question: QuestionView): string[] {
  const ids = [
    ...question.options.map((option) => question.optionArtifacts[option]),
    question.artifactId,
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

export interface RowLayout {
  id: string;
  title: string;
  note: string;
  y: number;
}
export interface FrameLayout {
  id: string;
  artifact: ArtifactView;
  /** Where the auto layout puts it, or where the user put it. */
  x: number;
  y: number;
  w: number;
  h: number | null;
}
/** A copy of a bound artifact with one option of its question applied. */
export interface CopyLayout {
  id: string;
  option: string;
  x: number;
  y: number;
  w: number;
  h: number | null;
}

/**
 * Lays the workspace out in rows: the artifacts tied to no question first,
 * the plan leading, then a row per question for the artifacts it is the
 * first to name. A frame the user moved stays where they put it, and keeps
 * its slot in the row, so nothing else moves. `heights` holds documents'
 * measured heights; `compare` adds a row of copies of one artifact.
 */
export function layoutCanvas(
  session: Pick<SessionView, "artifacts" | "questions">,
  positions: Record<string, FramePosition>,
  heights: Record<string, number>,
  compare?: { question: QuestionView; artifact: ArtifactView } | null,
): { rows: RowLayout[]; frames: FrameLayout[]; copies: CopyLayout[] } {
  const byId = new Map(
    session.artifacts.map((artifact) => [artifact.id, artifact]),
  );
  const placed = new Set<string>();
  const groups: Array<{
    id: string;
    title: string;
    note: string;
    ids: string[];
  }> = [];
  const owned = session.questions.map((question) => {
    const ids = questionArtifacts(question).filter(
      (id) => byId.has(id) && !placed.has(id),
    );
    ids.forEach((id) => placed.add(id));
    return ids;
  });
  const loose = session.artifacts.filter(
    (artifact) => !placed.has(artifact.id),
  );
  if (loose.length) {
    const plan = loose[0]!.kind === "plan";
    groups.push({
      id: "row:loose",
      title: plan ? "Plan" : "Not tied to a question",
      note: plan
        ? loose.length > 1
          ? "and items not tied to a question"
          : "kept by the agent"
        : "",
      ids: loose.map((artifact) => artifact.id),
    });
  }
  session.questions.forEach((question, index) => {
    if (owned[index]!.length)
      groups.push({
        id: `row:${question.id}`,
        title: `Question ${index + 1}`,
        note: question.prompt,
        ids: owned[index]!,
      });
  });

  const heightOf = (id: string, size: FrameSize) =>
    size.h ?? Math.max(PAGE_HEIGHT, heights[id] ?? 0);
  const rows: RowLayout[] = [];
  const frames: FrameLayout[] = [];
  let y = 0;
  for (const group of groups) {
    rows.push({ id: group.id, title: group.title, note: group.note, y });
    let x = 0;
    let tallest = 0;
    for (const id of group.ids) {
      const artifact = byId.get(id)!;
      const size = frameSize(artifact);
      const moved = positions[id];
      frames.push({
        id,
        artifact,
        x: moved?.x ?? x,
        y: moved?.y ?? y,
        w: size.w,
        h: size.h,
      });
      x += size.w + COL_GAP;
      tallest = Math.max(tallest, heightOf(id, size));
    }
    y += tallest + ROW_GAP;
  }

  const copies: CopyLayout[] = [];
  if (compare) {
    const number =
      session.questions.findIndex((q) => q.id === compare.question.id) + 1;
    rows.push({
      id: "row:compare",
      title: `Question ${number}`,
      note: `Comparing options on ${compare.artifact.title}`,
      y,
    });
    const size = frameSize(compare.artifact);
    const options =
      compare.question.type === "yes-no"
        ? ["Yes", "No"]
        : compare.question.options;
    options.forEach((option, index) =>
      copies.push({
        id: `copy:${index}`,
        option,
        x: index * (size.w + COL_GAP),
        y,
        w: size.w,
        h: size.h,
      }),
    );
  }
  return { rows, frames, copies };
}

/**
 * How far each frame's label may run, in canvas pixels from the frame's
 * left edge: up to the next frame to its right whose top band it shares,
 * as in Figma. Null when nothing is in the way.
 */
export function labelSpace(
  boxes: Array<{ id: string; x: number; y: number; w: number; h: number }>,
): Record<string, number | null> {
  return Object.fromEntries(
    boxes.map((box) => {
      const next = boxes
        .filter(
          (other) =>
            other !== box &&
            other.x >= box.x + box.w &&
            other.y < box.y + box.h &&
            other.y + other.h > box.y - 100,
        )
        .reduce<number | null>(
          (nearest, other) =>
            nearest === null ? other.x : Math.min(nearest, other.x),
          null,
        );
      return [box.id, next === null ? null : next - box.x];
    }),
  );
}
