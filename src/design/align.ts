import type { Status } from "./types.js";

/** One entry of a merged list: the current item, the base item, or both. */
export interface Merged<T> {
  status: Status;
  /** The current item, or the base item when it was removed. */
  item: T;
  /** The base item, for changed and same entries. */
  before?: T;
}

/**
 * Lines up `base` and `current` by `key` (longest common subsequence), then
 * pairs leftovers in the same gap that share a `group` as changed. The result
 * keeps the current order, with removed items where they used to sit.
 * Matched items whose `same` check fails count as changed too.
 */
export function align<T>(
  base: readonly T[],
  current: readonly T[],
  key: (item: T) => string,
  options: {
    group?: (item: T) => string;
    same?: (before: T, after: T) => boolean;
  } = {},
): Merged<T>[] {
  const a = base.map(key);
  const b = current.map(key);
  const n = a.length;
  const m = b.length;
  // lengths[i][j]: LCS length of a[i..] and b[j..].
  const lengths: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);

  const out: Merged<T>[] = [];
  let gapRemoved: T[] = [];
  let gapAdded: T[] = [];
  const flush = () => {
    const group = options.group;
    const removed = gapRemoved;
    // Pair leftovers in the same group: added index → removed index.
    const pairs = new Map<number, number>();
    if (group) {
      const used = new Set<number>();
      gapAdded.forEach((after, ai) => {
        const g = group(after);
        const ri = removed.findIndex((r, k) => !used.has(k) && group(r) === g);
        if (ri >= 0) {
          used.add(ri);
          pairs.set(ai, ri);
        }
      });
    }
    const paired = new Set(pairs.values());
    let next = 0; // the next removed item not yet placed
    const placeRemovedBefore = (limit: number) => {
      for (; next < limit && next < removed.length; next++)
        if (!paired.has(next))
          out.push({ status: "removed", item: removed[next]! });
    };
    gapAdded.forEach((item, ai) => {
      const ri = pairs.get(ai);
      if (ri !== undefined) {
        placeRemovedBefore(ri);
        out.push({ status: "changed", item, before: removed[ri]! });
        return;
      }
      // Removed items sit before what replaced them, up to the next pair.
      let limit = removed.length;
      for (let k = ai + 1; k < gapAdded.length; k++) {
        const later = pairs.get(k);
        if (later !== undefined) {
          limit = later;
          break;
        }
      }
      placeRemovedBefore(limit);
      out.push({ status: "added", item });
    });
    placeRemovedBefore(removed.length);
    gapRemoved = [];
    gapAdded = [];
  };

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      const before = base[i]!;
      const item = current[j]!;
      const same = options.same ? options.same(before, item) : true;
      out.push({ status: same ? "same" : "changed", item, before });
      i++;
      j++;
    } else if (
      j < m &&
      (i >= n || lengths[i]![j + 1]! >= lengths[i + 1]![j]!)
    ) {
      gapAdded.push(current[j]!);
      j++;
    } else {
      gapRemoved.push(base[i]!);
      i++;
    }
  }
  flush();
  return out;
}

/**
 * Matches items by identity (`key`), keeping the current order and putting
 * removed ones after the item they used to follow. For named things like
 * tables, fields and states, where a rename is a removal plus an addition.
 */
export function matchByKey<T>(
  base: readonly T[],
  current: readonly T[],
  key: (item: T) => string,
  same: (before: T, after: T) => boolean,
): Merged<T>[] {
  const baseKeys = base.map(key);
  const currentByKey = new Map(current.map((item) => [key(item), item]));
  const baseByKey = new Map(base.map((item) => [key(item), item]));
  const out: Merged<T>[] = current.map((item) => {
    const before = baseByKey.get(key(item));
    if (before === undefined) return { status: "added", item };
    return { status: same(before, item) ? "same" : "changed", item, before };
  });
  baseKeys.forEach((k, index) => {
    if (currentByKey.has(k)) return;
    // Put it after the nearest earlier base item that is still drawn.
    let at = 0;
    for (let p = index - 1; p >= 0; p--) {
      const prev = baseKeys[p]!;
      const pos = out.findIndex((e) => key(e.item) === prev);
      if (pos >= 0) {
        at = pos + 1;
        break;
      }
    }
    out.splice(at, 0, { status: "removed", item: base[index]! });
  });
  return out;
}
