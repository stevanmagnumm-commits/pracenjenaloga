import { fetchLatestStubs } from "./instagram-api";
import { VIEWS_WINDOW, bucketForAvg, type ViewBucket } from "./view-buckets";

/**
 * Standalone "how are these accounts performing" checker.
 *
 * Same metric the tracker shows as "Avg (last 36)": the mean view count of an
 * account's most recent 36 reels. The difference is that this tool takes a
 * pasted list of arbitrary usernames and scrapes them live, so accounts that
 * were never imported into the tracker can be graded too.
 *
 * Bucket definitions live in ./view-buckets so the UI can share them.
 */

export interface ViewsCheckResult {
  username: string;
  avgViews: number | null;
  /** How many reels the average is actually based on (can be < 36). */
  videosCounted: number;
  bucket: ViewBucket;
  /** Present when we could not grade the account at all. */
  note?: string;
}

export interface ViewsCheckProgress {
  total: number;
  completed: number;
  current: string | null;
  under100: number;
  mid: number;
  over200: number;
  nodata: number;
  running: boolean;
  results: ViewsCheckResult[];
}

// One account costs ~3 API calls (36 reels = 3 pages of 12) and roughly 3-4s,
// far more than the ban checker's single profile probe. A small pool keeps a
// few-hundred-account list workable; the API layer already backs off on 429.
const CONCURRENCY = 3;
// Breather between accounts within a worker, on top of the 800ms the reels
// pagination already waits between pages.
const RATE_DELAY = 400;

let progress: ViewsCheckProgress = {
  total: 0,
  completed: 0,
  current: null,
  under100: 0,
  mid: 0,
  over200: 0,
  nodata: 0,
  running: false,
  results: [],
};

export function getIgViewsCheckProgress(): ViewsCheckProgress {
  return progress;
}

export function stopIgViewsCheck(): void {
  if (progress.running) {
    progress.running = false;
    progress.current = null;
    console.log("[ig-views-check] Stopped by user");
  }
}

/**
 * Grade a single account.
 *
 * fetchLatestStubs swallows its own pagination errors and returns whatever it
 * managed to collect, so an empty result means "banned, private, no posts, or
 * the API refused" — all cases where we must NOT invent a bucket. Those land in
 * "nodata" instead of being reported as a 0-view account.
 */
async function checkOne(username: string): Promise<ViewsCheckResult> {
  try {
    const stubs = await fetchLatestStubs(username, VIEWS_WINDOW);
    if (stubs.length === 0) {
      return {
        username,
        avgViews: null,
        videosCounted: 0,
        bucket: "nodata",
        note: "no reels returned — banned, private, or has no posts",
      };
    }
    const total = stubs.reduce((sum, s) => sum + s.viewCount, 0);
    const avgViews = Math.round(total / stubs.length);
    return {
      username,
      avgViews,
      videosCounted: stubs.length,
      bucket: bucketForAvg(avgViews),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ig-views-check] @${username}:`, msg);
    return {
      username,
      avgViews: null,
      videosCounted: 0,
      bucket: "nodata",
      note: msg.slice(0, 160),
    };
  }
}

function countResult(result: ViewsCheckResult) {
  if (result.bucket === "under100") progress.under100++;
  else if (result.bucket === "mid") progress.mid++;
  else if (result.bucket === "over200") progress.over200++;
  else progress.nodata++;
}

export async function runIgViewsCheck(usernames: string[]): Promise<void> {
  if (progress.running) return;

  const cleaned = [
    ...new Set(
      usernames
        .map((u) => u.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean),
    ),
  ];

  progress = {
    total: cleaned.length,
    completed: 0,
    current: null,
    under100: 0,
    mid: 0,
    over200: 0,
    nodata: 0,
    running: true,
    results: [],
  };

  let nextIndex = 0;

  async function worker() {
    while (true) {
      if (!progress.running) return;
      const i = nextIndex++;
      if (i >= cleaned.length) return;

      const username = cleaned[i];
      progress.current = username;

      const result = await checkOne(username);
      progress.results.push(result);
      countResult(result);
      progress.completed++;

      if (nextIndex < cleaned.length && progress.running) {
        await new Promise((r) => setTimeout(r, RATE_DELAY));
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, cleaned.length) }, () => worker()),
    );
  } catch (err) {
    console.error("[ig-views-check] Batch error:", err);
  } finally {
    progress.current = null;
    progress.running = false;
    console.log(
      `[ig-views-check] Done. <100: ${progress.under100}, 100-200: ${progress.mid}, 200+: ${progress.over200}, no data: ${progress.nodata}`,
    );
  }
}
