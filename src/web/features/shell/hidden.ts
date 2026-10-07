import { useCallback, useEffect, useState } from "react";
import type { InboxItem } from "../../../shared/inbox.js";

const KEY = "kim-inbox-hidden";
const SNOOZE_MS = 60 * 60 * 1000;
/** "Done" hides an item until its id changes or it leaves and comes back. */
const FOREVER = Number.MAX_SAFE_INTEGER;

type Hidden = Record<string, number>;

function load(): Hidden {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Hidden;
  } catch {
    return {};
  }
}

function save(hidden: Hidden): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(hidden));
  } catch {
    /* private mode: it lasts until the page reloads */
  }
}

/**
 * Inbox items this browser has dealt with ("Done → next") or snoozed for an
 * hour. Ids no longer in the inbox are forgotten, so an item that comes
 * back shows again.
 */
export function useHiddenItems(items: InboxItem[] | null) {
  const [hidden, setHidden] = useState<Hidden>(load);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!items) return;
    const present = new Set(items.map((item) => item.id));
    setHidden((current) => {
      const kept = Object.fromEntries(
        Object.entries(current).filter(
          ([id, until]) => present.has(id) && until > Date.now(),
        ),
      );
      if (Object.keys(kept).length === Object.keys(current).length)
        return current;
      save(kept);
      return kept;
    });
  }, [items, now]);
  const hide = useCallback((id: string, until: number) => {
    setHidden((current) => {
      const next = { ...current, [id]: until };
      save(next);
      return next;
    });
  }, []);
  return {
    visible: (items ?? []).filter((item) => (hidden[item.id] ?? 0) <= now),
    done: (id: string) => hide(id, FOREVER),
    snooze: (id: string) => hide(id, Date.now() + SNOOZE_MS),
  };
}
