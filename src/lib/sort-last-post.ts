/**
 * Ordering a list of accounts by when each last posted.
 *
 * Kept out of the component so it can be tested on its own, because the part
 * that matters is not the ordering but what happens to an account with no
 * date: that means the posts could not be read, not that it posted long ago.
 * Mixing those in with the real dates would quietly turn "not known" into
 * "oldest", so they sit at the bottom whichever way the column points.
 */

export type SortMode = "none" | "newest" | "oldest";

export function byLastPost<T extends { lastPostAt: string | null }>(
  mode: SortMode,
): (a: T, b: T) => number {
  return (a, b) => {
    if (mode === "none") return 0;
    const ta = a.lastPostAt ? Date.parse(a.lastPostAt) : NaN;
    const tb = b.lastPostAt ? Date.parse(b.lastPostAt) : NaN;
    const na = Number.isNaN(ta);
    const nb = Number.isNaN(tb);
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return mode === "newest" ? tb - ta : ta - tb;
  };
}

export function nextSortMode(mode: SortMode): SortMode {
  return mode === "newest" ? "oldest" : mode === "oldest" ? "none" : "newest";
}
