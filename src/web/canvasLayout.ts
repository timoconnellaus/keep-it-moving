import type {
  ArtifactView,
  FramePosition,
  QuestionView,
  SessionView,
} from "../shared/schema.js";

/** Space between frames in a row, and between rows, in canvas pixels. */
export const COL_GAP = 120;
export const ROW_GAP = 700;
/** Plans and documents are a page wide, and at least a page tall. */
export const PAGE_WIDTH = 620;
export const PAGE_HEIGHT = 760;

export interface FrameSize {
  w: number;
  /** Null for documents, which are as tall as their text. */
  h: number | null;
}

/**
 * The size a frame shows an artifact at. Mockups are desktop pages unless
 * their title or description says phone or tablet; documents are a page.
 */
export function frameSize(artifact: ArtifactView): FrameSize {
  if (artifact.format === "markdown" || artifact.format === "text")
    return { w: PAGE_WIDTH, h: null };
  const words = `${artifact.title} ${artifact.description ?? ""}`;
  if (artifact.format === "html" && /\b(mobile|phone)\b/i.test(words))
    return { w: 390, h: 844 };
  if (artifact.format === "html" && /\b(tablet|ipad)\b/i.test(words))
    return { w: 834, h: 1112 };
  return { w: 1280, h: 800 };
}

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
