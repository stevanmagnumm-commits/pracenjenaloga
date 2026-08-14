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

export type ViewBucket = "under100" | "mid" | "over200" | "nodata";

export const VIEW_BUCKET_ORDER: ViewBucket[] = ["under100", "mid", "over200", "nodata"];

export const VIEW_BUCKET_LABEL: Record<ViewBucket, string> = {
  under100: "< 100",
  mid: "100 – 200",
  over200: "200+",
  nodata: "No data",
};

/** 100-200 includes 100 and excludes 200, so exactly 200 lands in "200+". */
export function bucketForAvg(avg: number | null): ViewBucket {
  if (avg === null) return "nodata";
  if (avg < 100) return "under100";
  if (avg < 200) return "mid";
  return "over200";
}
