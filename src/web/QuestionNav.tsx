import { useEffect, useState, type RefObject } from "react";
import type { QuestionView } from "../shared/schema.js";

const cardFor = (root: HTMLElement | null | undefined, id: string) =>
  [...(root?.querySelectorAll<HTMLElement>("[data-question-id]") ?? [])].find(
    (card) => card.dataset.questionId === id,
  );

/** "N of M answered" over the questions; skipped questions count as answered. */
export function QuestionProgress({ questions }: { questions: QuestionView[] }) {
  const total = questions.length;
  if (total === 0) return null;
  const done = questions.filter((question) => question.answer).length;
  return (
    <div className="question-progress" role="status">
      <span className="question-progress-count">
        {done} of {total} answered
      </span>
      <span className="question-progress-bar" aria-hidden="true">
        <span style={{ width: `${(done / total) * 100}%` }} />
      </span>
    </div>
  );
}

/**
 * A sticky pill at the foot of the questions that scrolls to the next open
 * question while any open question sits below the visible part of the page.
 */
export function MoreBelow({
  container,
  questions,
}: {
  container: RefObject<HTMLElement | null>;
  questions: QuestionView[];
}) {
  const [below, setBelow] = useState<string[]>([]);
  const openIds = questions
    .filter((question) => !question.answer)
    .map((question) => question.id);
  const openKey = openIds.join(" ");

  useEffect(() => {
    setBelow([]);
    const root = container.current;
    if (
      !root ||
      openIds.length === 0 ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const hidden = new Set<string>();
    // The pill covers the foot of the page, so a card behind it counts as below.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.questionId!;
          const bottom = entry.rootBounds?.bottom ?? window.innerHeight;
          if (!entry.isIntersecting && entry.boundingClientRect.top >= bottom)
            hidden.add(id);
          else hidden.delete(id);
        }
        setBelow(openIds.filter((id) => hidden.has(id)));
      },
      { rootMargin: "0px 0px -56px 0px" },
    );
    for (const id of openIds) {
      const card = cardFor(root, id);
      if (card) observer.observe(card);
    }
    return () => observer.disconnect();
  }, [container, openKey]);

  if (below.length === 0) return null;
  const next = () =>
    cardFor(container.current, below[0]!)?.scrollIntoView({ block: "start" });
  return (
    <button type="button" className="more-below" onClick={next}>
      ↓ {below.length} more question{below.length === 1 ? "" : "s"} below
    </button>
  );
}
