import { fetchLatestStubs, fetchProfile } from "./instagram-api";
import {
  VIEWS_WINDOW,
  bucketForAvg,
  emptyBucketCounts,
  type BucketCounts,
  type ViewBucket,
} from "./view-buckets";

/**
 * Standalone "how are these accounts performing" checker.
 *
 * Grades an account by the mean view count of its most recent reels, pinned
 * posts excluded. The window is VIEWS_WINDOW (24), deliberately shorter than
 * the tracker's "Avg (last 36)" column so a live account costs two calls
 * instead of three — see view-buckets.ts. It takes a pasted list of arbitrary
 * usernames and scrapes them live, so accounts that were never imported into
 * the tracker can be graded too.
 *
 * Bucket definitions live in ./view-buckets so the UI can share them.
 *
 * Two passes
 * ----------
 * 1. Profile first, then reels for whoever is alive. "Not found" answers are
 *    parked instead of judged, so the pass never stalls.
 * 2. Second opinion on the parked ones. A ban is never declared on a single
 *    answer, exactly like ig-ban-check.ts. The gap between the two probes ends
 *    up being the length of pass 1 — far more separation than the 8s the Ban
 *    Checker settles for, and without any worker sitting idle.
 *
 * Cost per account, which matters because the plan allows only 50 calls/minute:
 * a banned account is 2 profile calls, an empty one 1 profile + 1 reels, a live
 * one 1 profile + 2 reels (24 reels = 2 pages). On a mostly dead list that
 * averages ~2.2.
 *
 * Why the profile endpoint outranks the reels endpoint
 * ---------------------------------------------------
 * The reels endpoint lies in two ways, both measured live. It returns an empty
 * array on HTTP 200 for accounts that answer with 12 reels seconds later; and
 * when the plan's 50-calls-per-minute cap is hit it answers HTTP 200 with
 * {"message":"You have exceeded the rate limit..."}, which has no `reels` key
 * and used to be read as "this account has no reels". On a 308-account run that
 * produced 239 "No data" rows; a direct probe of a sample found 40% of them
 * alive. Both shapes are now recognised and retried in instagram-api.ts, and an
 * empty reels answer is never a verdict on its own.
 */

export interface ViewsCheckResult {
  username: string;
  avgViews: number | null;
  /** How many reels the average is actually based on (can be < the window). */
  videosCounted: number;
  bucket: ViewBucket;
  /** Present whenever the account could not be graded, explaining why. */
  note?: string;
}

export type CheckPhase = "idle" | "checking" | "confirming" | "done";

export interface ViewsCheckProgress {
  total: number;
  completed: number;
  current: string | null;
  /** Which pass is running — the UI shows this so a slow pass isn't a mystery. */
  phase: CheckPhase;
  /** Accounts parked for the confirmation pass (not yet counted in `completed`). */
  pending: number;
  counts: BucketCounts;
  running: boolean;
  results: ViewsCheckResult[];
}

// How many accounts are in flight against RapidAPI at once.
//
// This is NOT a free knob. The plan is capped at 50 calls/minute, and six
// workers were measured on a live 174-account run at 40 calls/minute — 80% of
// the ceiling, with zero 429s. So there is a little headroom and no more:
// pushing the pool much higher buys "you have exceeded the rate limit" bodies,
// which is the answer that used to be misread as "this account has no reels".
// Wall-clock is won by spending fewer calls per account, not by more workers.
const CONCURRENCY = Math.max(1, Number(process.env.IG_VIEWS_CONCURRENCY) || 6);

// Extra reels attempts for an account confirmed alive. fetchLatestStubs already
// retries an empty first page once internally, so this sits on top of that.
const EMPTY_REELS_RETRIES = 2;
const EMPTY_REELS_DELAY = 3_000;

// "Not found" answers needed before a ban is declared, matching ig-ban-check.ts
// on the "stable" provider.
const BAN_CONFIRMATIONS = 2;

function freshProgress(total: number, running: boolean): ViewsCheckProgress {
  return {
    total,
    completed: 0,
    current: null,
    phase: running ? "checking" : "idle",
    pending: 0,
    counts: emptyBucketCounts(),
    running,
    results: [],
  };
}

let progress: ViewsCheckProgress = freshProgress(0, false);

// Incremented on every start. Workers from a stopped run capture the token they
// began with, so if the user stops a check and immediately starts another, the
// stragglers still finishing a fetch cannot push results into the new run's
// progress or drive its counters past `total`.
let runToken = 0;

export function getIgViewsCheckProgress(): ViewsCheckProgress {
  return progress;
}

export function stopIgViewsCheck(): void {
  if (progress.running) {
    progress.running = false;
    progress.current = null;
    progress.phase = "done";
    console.log("[ig-views-check] Stopped by user");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ProfileState =
  | { state: "alive"; mediaCount: number }
  | { state: "missing" }
  | { state: "inconclusive"; reason: string };

/**
 * One profile probe, using the same signal split as the Ban Checker:
 *   alive        -> profile came back
 *   missing      -> the API explicitly said the profile was not found
 *   inconclusive -> rate limit, 5xx, timeout, unusable body
 * A transient failure must never be read as a ban.
 */
async function probeProfile(username: string): Promise<ProfileState> {
  try {
    const profile = await fetchProfile(username);
    return { state: "alive", mediaCount: profile.mediaCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Profile not found") || msg.includes("data not found")) {
      return { state: "missing" };
    }
    return { state: "inconclusive", reason: msg };
  }
}

function ungraded(username: string, bucket: ViewBucket, note: string): ViewsCheckResult {
  return { username, avgViews: null, videosCounted: 0, bucket, note };
}

/**
 * Pull reels for an account confirmed alive and grade it.
 *
 * An account whose profile reports 0 posts gets a single confirming look rather
 * than the full retry ladder — but it still gets one, because a media_count of
 * 0 can also mean the field was missing from a half-formed response, and a live
 * account with posts must never be filed as empty.
 */
async function gradeAlive(
  username: string,
  mediaCount: number | null,
  isActive: () => boolean,
): Promise<ViewsCheckResult> {
  // An account the profile says is empty only needs one confirming look.
  const attempts = mediaCount === 0 ? 1 : EMPTY_REELS_RETRIES + 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(EMPTY_REELS_DELAY);
      if (!isActive()) return ungraded(username, "failed", "stopped by user");
      console.log(`[ig-views-check] @${username} empty reels, attempt ${attempt + 1}`);
    }
    const stubs = await fetchLatestStubs(username, VIEWS_WINDOW);
    if (stubs.length > 0) {
      const total = stubs.reduce((sum, s) => sum + s.viewCount, 0);
      const avgViews = Math.round(total / stubs.length);
      return {
        username,
        avgViews,
        videosCounted: stubs.length,
        bucket: bucketForAvg(avgViews),
      };
    }
  }

  let posts = mediaCount;
  if (posts === null) {
    const profile = await probeProfile(username);
    if (profile.state === "alive") posts = profile.mediaCount;
  }

  if (posts === 0) {
    console.log(`[ig-views-check] @${username} -> NO POSTS`);
    return ungraded(username, "noposts", "alive, nothing posted yet");
  }

  console.log(`[ig-views-check] @${username} -> NO REELS (${posts ?? "?"} posts)`);
  return ungraded(
    username,
    "noreels",
    posts === null
      ? "alive, but no reels came back — photos only, or the API kept failing"
      : `alive with ${posts} posts but no reels — photos only`,
  );
}

interface Job {
  username: string;
}

/**
 * Classify one account. On pass 1 a "not found" is parked (returns null) for the
 * confirmation pass; on the confirmation pass every outcome is final.
 */
async function classify(
  job: Job,
  isConfirmPass: boolean,
  isActive: () => boolean,
): Promise<ViewsCheckResult | null> {
  const { username } = job;
  try {
    const profile = await probeProfile(username);

    if (profile.state === "alive") {
      return await gradeAlive(username, profile.mediaCount, isActive);
    }

    if (!isConfirmPass) return null; // park it — pass 2 gets the second opinion

    if (profile.state === "missing") {
      console.log(`[ig-views-check] @${username} -> BANNED (confirmed ${BAN_CONFIRMATIONS}x)`);
      return ungraded(
        username,
        "banned",
        `profile not found ${BAN_CONFIRMATIONS}x — banned or deleted`,
      );
    }

    console.log(`[ig-views-check] @${username} -> FAILED (${profile.reason})`);
    return ungraded(username, "failed", `could not check: ${profile.reason.slice(0, 140)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ig-views-check] @${username}:`, msg);
    return ungraded(username, "failed", msg.slice(0, 160));
  }
}

/** Run `fn` over `items` with `limit` in flight, stopping when inactive. */
async function pool<T>(
  items: T[],
  limit: number,
  isActive: () => boolean,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (isActive()) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function runIgViewsCheck(usernames: string[]): Promise<void> {
  if (progress.running) return;

  const cleaned = [
    ...new Set(
      usernames.map((u) => u.trim().replace(/^@/, "").toLowerCase()).filter(Boolean),
    ),
  ];

  const myToken = ++runToken;
  const isActive = () => progress.running && runToken === myToken;

  progress = freshProgress(cleaned.length, true);

  const finalize = (result: ViewsCheckResult) => {
    if (!isActive()) return;
    progress.results.push(result);
    progress.counts[result.bucket]++;
    progress.completed++;
  };

  try {
    const jobs: Job[] = cleaned.map((username) => ({ username }));

    const parked: Job[] = [];
    await pool(jobs, CONCURRENCY, isActive, async (job) => {
      progress.current = job.username;
      const result = await classify(job, false, isActive);
      if (result) finalize(result);
      else if (isActive()) {
        parked.push(job);
        progress.pending = parked.length;
      }
    });

    // Pass 2 — second opinion on the parked ones, well separated in time.
    if (parked.length && isActive()) {
      progress.phase = "confirming";
      console.log(`[ig-views-check] Pass 2: re-probing ${parked.length} accounts`);
      await pool(parked, CONCURRENCY, isActive, async (job) => {
        progress.current = job.username;
        const result = await classify(job, true, isActive);
        if (result) finalize(result);
        if (isActive()) progress.pending = Math.max(0, progress.pending - 1);
      });
    }
  } catch (err) {
    console.error("[ig-views-check] Batch error:", err);
  } finally {
    if (runToken === myToken) {
      progress.current = null;
      progress.running = false;
      progress.phase = "done";
      progress.pending = 0;
      const c = progress.counts;
      console.log(
        `[ig-views-check] Done. <100: ${c.under100}, 100-200: ${c.mid}, 200+: ${c.over200}, ` +
          `banned: ${c.banned}, no posts: ${c.noposts}, no reels: ${c.noreels}, failed: ${c.failed}`,
      );
    }
  }
}
