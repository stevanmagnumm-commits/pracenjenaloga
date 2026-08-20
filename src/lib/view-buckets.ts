// Shared definition of the Views Checker buckets.
//
// Kept dependency-free (exactly like category.ts) so both the server-side
// checker and the client component can import it — pulling ig-views-check.ts
// into a "use client" file would drag Prisma into the browser bundle.
//
// These are NOT the scheduler categories. src/lib/category.ts (800/200/50)
// stays the single source of truth for those; the thresholds here answer a
// separate question: "of these pasted accounts, which are under 100, which are
// 100-200, which are above".

/** Rolling window, matching the tracker's "Avg (last 36)". */
export const VIEWS_WINDOW = 36;

/**
 * Three graded buckets plus four distinct reasons an account carries no number.
 * They used to be a single "No data" pile, which was useless in practice: a
 * banned account, a brand-new empty one, a photos-only one and a request the
 * provider fumbled all landed together, so there was no way to tell which rows
 * were worth re-running and which were fine as they are.
 *
 * Only one of the four is a problem:
 *   banned   — the account is gone
 *   noposts  — alive, nothing posted yet; a normal state for a fresh account
 *   noreels  — alive and posting, but no reels (photos only), nothing to average
 *   failed   — no answer from the provider; these are the ones worth re-running
 */
export type ViewBucket =
  | "under100"
  | "mid"
  | "over200"
  | "banned"
  | "noposts"
  | "noreels"
  | "failed";

export const VIEW_BUCKET_ORDER: ViewBucket[] = [
  "under100",
  "mid",
  "over200",
  "banned",
  "noposts",
  "noreels",
  "failed",
];

export const VIEW_BUCKET_LABEL: Record<ViewBucket, string> = {
  under100: "< 100",
  mid: "100 – 200",
  over200: "200+",
  banned: "Banned",
  noposts: "No posts",
  noreels: "No reels",
  failed: "Check failed",
};

/** Buckets that carry no view number — sorted to the bottom, never graded. */
export const UNGRADED_BUCKETS: ViewBucket[] = [
  "banned",
  "noposts",
  "noreels",
  "failed",
];

export type BucketCounts = Record<ViewBucket, number>;

export function emptyBucketCounts(): BucketCounts {
  return {
    under100: 0,
    mid: 0,
    over200: 0,
    banned: 0,
    noposts: 0,
    noreels: 0,
    failed: 0,
  };
}

/**
 * 100-200 includes 100 and excludes 200, so exactly 200 lands in "200+".
 * A null average never reaches here any more — the caller picks the right
 * ungraded bucket — but it stays mapped to "failed" so a future caller cannot
 * silently produce an account with no bucket at all.
 */
export function bucketForAvg(avg: number | null): ViewBucket {
  if (avg === null) return "failed";
  if (avg < 100) return "under100";
  if (avg < 200) return "mid";
  return "over200";
}
