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
 * posts excluded, over VIEWS_WINDOW reels — the same window the tracker shows
 * as "Avg (last 36)". It takes a pasted list of arbitrary usernames and scrapes
 * them live, so accounts that were never imported into the tracker can be
 * graded too.
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
 * one 1 profile + 3 reels (36 reels = 3 pages).
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
  /**
   * The parked usernames themselves. Exposed because they used to exist only
   * inside the running function: when a run froze mid-pass, the 430 accounts
   * waiting for a verdict were unrecoverable from the API and had to be
   * reconstructed by diffing the input file against the finished results.
   */
  parked: string[];
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

// Declaring a ban is the one verdict this tool cannot take back, and it was
// getting it wrong more than half the time.
//
// Measured today: of 215 accounts this checker called banned, the Ban Checker —
// same endpoint, same key, same accounts — found 59 of the first 113 ALIVE.
// The two tools do not differ in logic; they differ in load. The Ban Checker
// walks the list one account at a time, 1.3s apart. This one had six probes in
// flight, and under that pressure the provider answers "data not found" for
// accounts that are perfectly alive. Two confirmations taken under the same
// pressure fail together — confirmation without independence confirms nothing.
//
// So the confirmation pass now copies ig-ban-check.ts exactly: sequential, one
// account at a time, RATE_DELAY between accounts, BAN_CONFIRMATIONS consecutive
// "not found" answers spaced RECHECK_DELAY apart, a single "alive" clears the
// account, and anything unclear stops the probing and returns unclear — never a
// ban. Those numbers are not guesses; that configuration was measured correct on
// these very accounts today.
//
// Cost: roughly 10-20s per parked account, single file. Discovery stays
// parallel — only the judgement is slow.
const BAN_CONFIRMATIONS = 2;
const RECHECK_DELAY = 8_000;
const CONFIRM_CONCURRENCY = 1;
const CONFIRM_RATE_DELAY = 1_300;

function freshProgress(total: number, running: boolean): ViewsCheckProgress {
  return {
    total,
    completed: 0,
    current: null,
    phase: running ? "checking" : "idle",
    pending: 0,
    parked: [],
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

// A hard ceiling on how long ONE account may occupy a worker.
//
// Every HTTP call already has its own 20s deadline, and every loop here is
// bounded — and yet a live run froze solid with 3388 of 3818 done: five workers
// idle, one stuck somewhere that no per-request timeout covered, and Promise.all
// waiting on it forever. Pass 2 never started, so all 430 parked accounts were
// left without a verdict and had to be reconstructed from the input file by
// hand. Reasoning about which await can hang is how that bug got shipped; this
// stops caring. If an account exceeds its budget it is recorded as failed and
// the run moves on.
//
// The stuck work is not cancellable, so it keeps running in the background —
// but it no longer holds the pool, and the run finishes.
const TRIAGE_DEADLINE = 120_000;
// Pass 2 legitimately takes longer: two probes with an 8s recheck between them,
// then up to three reels attempts if the account turns out alive.
const CONFIRM_DEADLINE = 180_000;

async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  onExpiry: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onExpiry()), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
 * Pass 1: one cheap probe. Alive accounts get graded straight away; anything
 * else is parked (returns null) without a verdict, because a single answer
 * taken under six-way parallel load is not evidence of anything.
 */
async function triage(
  job: Job,
  isActive: () => boolean,
): Promise<ViewsCheckResult | null> {
  const { username } = job;
  try {
    const profile = await probeProfile(username);
    if (profile.state === "alive") {
      return await gradeAlive(username, profile.mediaCount, isActive);
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ig-views-check] @${username}:`, msg);
    return ungraded(username, "failed", msg.slice(0, 160));
  }
}

/**
 * Pass 2: the verdict, using checkProfile() from ig-ban-check.ts line for line.
 *
 *   - a single "alive" clears the account immediately, at any probe
 *   - anything unclear (rate limit, timeout, unusable body) STOPS the probing
 *     and returns unclear — a transient failure never becomes a ban
 *   - only BAN_CONFIRMATIONS consecutive "not found" answers, RECHECK_DELAY
 *     apart, are allowed to mean banned
 *
 * The caller runs this one account at a time. That is the part that matters.
 */
async function confirm(
  job: Job,
  isActive: () => boolean,
): Promise<ViewsCheckResult> {
  const { username } = job;
  try {
    for (let probe = 0; probe < BAN_CONFIRMATIONS; probe++) {
      if (probe > 0) {
        await sleep(RECHECK_DELAY);
        if (!isActive()) return ungraded(username, "failed", "stopped by user");
      }
      const profile = await probeProfile(username);

      if (profile.state === "alive") {
        const note = probe === 0 ? "" : " (recovered on recheck)";
        console.log(`[ig-views-check] @${username} -> ALIVE${note}`);
        return await gradeAlive(username, profile.mediaCount, isActive);
      }
      if (profile.state === "inconclusive") {
        console.log(`[ig-views-check] @${username} -> UNCLEAR (${profile.reason.slice(0, 60)})`);
        return ungraded(
          username,
          "failed",
          `could not check: ${profile.reason.slice(0, 140)}`,
        );
      }
      // "missing" — keep probing until BAN_CONFIRMATIONS agree.
    }

    console.log(`[ig-views-check] @${username} -> BANNED (confirmed ${BAN_CONFIRMATIONS}x)`);
    return ungraded(
      username,
      "banned",
      `profile not found ${BAN_CONFIRMATIONS}x, ${RECHECK_DELAY / 1000}s apart — banned or deleted`,
    );
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
      const result = await withDeadline(triage(job, isActive), TRIAGE_DEADLINE, () => {
        console.error(`[ig-views-check] @${job.username} exceeded ${TRIAGE_DEADLINE / 1000}s — abandoned`);
        return ungraded(job.username, "failed", `no answer within ${TRIAGE_DEADLINE / 1000}s`);
      });
      if (result) finalize(result);
      else if (isActive()) {
        parked.push(job);
        progress.parked = parked.map((j) => j.username);
        progress.pending = parked.length;
      }
    });

    // Pass 2 — the verdict, at the Ban Checker's pace: CONFIRM_CONCURRENCY (1)
    // account at a time with CONFIRM_RATE_DELAY between them. Running this in
    // parallel is precisely what produced 52% false bans; the slowness is the
    // feature.
    if (parked.length && isActive()) {
      progress.phase = "confirming";
      console.log(
        `[ig-views-check] Pass 2: confirming ${parked.length} accounts one at a time`,
      );
      await pool(parked, CONFIRM_CONCURRENCY, isActive, async (job) => {
        progress.current = job.username;
        const result = await withDeadline(confirm(job, isActive), CONFIRM_DEADLINE, () => {
          console.error(`[ig-views-check] @${job.username} exceeded ${CONFIRM_DEADLINE / 1000}s — abandoned`);
          return ungraded(job.username, "failed", `no answer within ${CONFIRM_DEADLINE / 1000}s`);
        });
        finalize(result);
        progress.parked = progress.parked.filter((u) => u !== job.username);
        if (isActive()) progress.pending = Math.max(0, progress.pending - 1);
        if (isActive()) await sleep(CONFIRM_RATE_DELAY);
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
      progress.parked = [];
      const c = progress.counts;
      console.log(
        `[ig-views-check] Done. <100: ${c.under100}, 100-200: ${c.mid}, 200+: ${c.over200}, ` +
          `banned: ${c.banned}, no posts: ${c.noposts}, no reels: ${c.noreels}, failed: ${c.failed}`,
      );
    }
  }
}
