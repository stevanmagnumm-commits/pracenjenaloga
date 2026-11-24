import {
  fetchLatestStubs,
  fetchProfile,
  probeLivenessWithoutProfile,
  apiWallReason,
  standingApiWall,
  clearApiWall,
  dateFromMediaPk,
  dateFromShortcode,
  extractShortcode,
  fetchOwnerReelIndex,
  probeReelViewsDirect,
  type OwnerReelIndex,
} from "./instagram-api";
import {
  VIEWS_WINDOW,
  RECENT_WINDOW,
  bucketForAvg,
  emptyBucketCounts,
  type BucketCounts,
  type ViewBucket,
} from "./view-buckets";
import { runInLane, laneWorkers } from "./api-lanes";

import {
  saveJson,
  loadJson,
  readLines,
  removeFiles,
  ResultLog,
} from "./run-state";

/** So a restart cannot take the list of accounts still to grade with it. */
const WORK_FILE = "views-check-work.json";
const RESULTS_FILE = "views-check-results.jsonl";

interface SavedViewsWork {
  usernames: string[];
  startedAt: number;
  /**
   * Which kind of run this was. Absent on files written before reel mode
   * existed, which is why the reader defaults to "accounts" - without that, a
   * list of shortcodes left behind by an interrupted reel run would be resumed
   * as a list of usernames and checked as 17 nonexistent accounts.
   */
  mode?: "accounts" | "reels";
  reels?: ReelViewsJob[];
}

/** One pasted line, after parsing: the owner, the reel, and the URL as given. */
export interface ReelViewsJob {
  /** The username on the line. Empty when the line was a bare URL. */
  label: string;
  shortcode: string;
  url: string;
}

export interface ResumableViewsCheck {
  total: number;
  done: number;
  remaining: number;
}

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
 * Cost per account (the plan allows 300 calls/minute, enforced in rate-limit.ts):
 * a banned account is 2 profile calls, an empty one 1 profile + 1 reels, a live
 * one 1 profile + 3 reels (36 reels = 3 pages).
 *
 * Why the profile endpoint outranks the reels endpoint
 * ---------------------------------------------------
 * The reels endpoint lies in two ways, both measured live. It returns an empty
 * array on HTTP 200 for accounts that answer with 12 reels seconds later; and
 * when the plan per-minute cap is hit it answers HTTP 200 with
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
  /**
   * The same thing over RECENT_WINDOW reels instead, shown beside it. The
   * bucket never comes from this one. Absent on rows written before it
   * existed, which is why it is optional rather than null.
   */
  avgViews6?: number | null;
  videosCounted6?: number;
  bucket: ViewBucket;
  /** Present whenever the account could not be graded, explaining why. */
  note?: string;
  /**
   * Set only by reel mode: the one reel this row is about. Its presence is
   * what tells a reader - and the table header - that `avgViews` is a single
   * reel's view count and not an average over a window.
   */
  shortcode?: string;
  url?: string;
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
  /**
   * Set when the run stopped itself rather than finishing. Today that means the
   * monthly API quota is gone — a condition that does not clear for days, so
   * grinding on is worse than useless: every attempt still counts against the
   * plan, which is how one run kept the quota at zero for five days straight.
   * The panel shows this instead of leaving a wall of "Check failed".
   */
  abortedReason: string | null;
  counts: BucketCounts;
  running: boolean;
  results: ViewsCheckResult[];
}

// How many accounts are in flight against RapidAPI at once.
//
// This was six for a long time, and six was right while the plan allowed 50
// calls a minute and nothing in the code enforced that ceiling — the pool size
// WAS the rate limit, and overshooting it bought "you have exceeded the rate
// limit" bodies, which were misread as "this account has no reels".
//
// Both halves of that have changed. The plan now allows 300 a minute, and
// rate-limit.ts enforces a real ceiling on every call the app makes, so the
// pool no longer stands in for one. Sized from the arithmetic instead: the
// budget divided by the measured ~8.6s a call takes is about forty in flight to
// keep it full. Going higher is harmless but pointless — the extra workers
// would simply queue at the limiter.
const CONCURRENCY = Math.max(1, Number(process.env.IG_VIEWS_CONCURRENCY) || 40);

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
// The cure was to copy ig-ban-check.ts exactly, including its sequential walk.
// Read that paragraph again, though: the two tools "do not differ in logic;
// they differ in LOAD". Sequential was how load was kept down, not the point in
// itself — and load is now held down directly, by rate-limit.ts, on every call
// the app makes.
//
// So the pass runs several accounts side by side again, and what actually
// protects the verdict is kept exactly as measured: BAN_CONFIRMATIONS
// consecutive "not found" answers spaced RECHECK_DELAY apart, a single "alive"
// clears the account, anything unclear stops the probing and returns unclear —
// never a ban. Those are the numbers that were measured correct on these very
// accounts, and none of them have moved.
//
// If false bans ever reappear, this is the first place to look, and
// IG_CONFIRM_CONCURRENCY=1 restores the old behaviour without a deploy.
const BAN_CONFIRMATIONS = 2;
const RECHECK_DELAY = 8_000;
const CONFIRM_CONCURRENCY = Math.max(1, Number(process.env.IG_CONFIRM_CONCURRENCY) || 24);
const CONFIRM_RATE_DELAY = Number(process.env.IG_CONFIRM_RATE_DELAY ?? 0);

function freshProgress(total: number, running: boolean): ViewsCheckProgress {
  return {
    total,
    completed: 0,
    current: null,
    phase: running ? "checking" : "idle",
    pending: 0,
    parked: [],
    abortedReason: null,
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

// Raised the moment the provider says the monthly quota is gone. Checked by
// isActive(), so both passes wind down instead of hammering a dead plan.
let quotaAbort: string | null = null;

/**
 * Whether the API itself is walled off - quota gone, or the subscription
 * refusing the key. Read from the API layer rather than from a caught error,
 * because a caught error can be swallowed and this must not be missable.
 */
function wallHit(): boolean {
  if (quotaAbort) return true;
  const wall = standingApiWall();
  if (!wall) return false;
  quotaAbort = wall;
  console.error("[ig-views-check] ABORT: " + wall);
  return true;
}

function noteIfQuotaDead(err: unknown): void {
  if (quotaAbort) return;
  const wall = apiWallReason(err);
  if (!wall) return;
  quotaAbort = wall;
  console.error(`[ig-views-check] ABORT: ${quotaAbort}`);
}

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
  | { state: "alive"; mediaCount: number | null; via?: string }
  | { state: "missing"; via?: string }
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
    noteIfQuotaDead(err);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Profile not found") || msg.includes("data not found")) {
      return { state: "missing" };
    }

    // The profile endpoint refused. It is not the only endpoint that can
    // answer this question, and on 2026-11-05 it was the only one that was
    // down - so ask the one that is still up rather than abandoning an
    // account whose reels are sitting right there. See probeReelsLiveness.
    //
    // Only its two unambiguous answers are honoured: reels in hand means
    // alive, and the "user does not exist" sentence means gone. Anything
    // else leaves the original refusal standing as the reason, because the
    // account still has not been looked at.
    const other = await probeLivenessWithoutProfile(username);
    if (other.state === "alive") {
      return { state: "alive", mediaCount: null, via: `${other.via} (${other.how})` };
    }
    if (other.state === "missing") {
      return { state: "missing", via: other.via.join(" + ") };
    }
    return { state: "inconclusive", reason: msg };
  }
}

/**
 * Mark a row the profile endpoint had no hand in, so a run graded during an
 * outage can be told apart from a normal one months later, from the export
 * alone. A number with no provenance is the kind of thing that gets trusted
 * once the reason for doubting it has been forgotten.
 */
function viaNote(via: string): string {
  return `profile endpoint refusing - read from ${via}`;
}

function markedViaReels(result: ViewsCheckResult, via: string): ViewsCheckResult {
  const mark = viaNote(via);
  return {
    ...result,
    note: result.note ? `${result.note} (${mark})` : mark,
  };
}

function ungraded(username: string, bucket: ViewBucket, note: string): ViewsCheckResult {
  return {
    username,
    avgViews: null,
    videosCounted: 0,
    avgViews6: null,
    videosCounted6: 0,
    bucket,
    note,
  };
}

/**
 * Pull reels for an account confirmed alive and grade it.
 *
 * An account whose profile reports 0 posts gets a single confirming look rather
 * than the full retry ladder — but it still gets one, because a media_count of
 * 0 can also mean the field was missing from a half-formed response, and a live
 * account with posts must never be filed as empty.
 */
/**
 * When a reel was posted, read out of its media id.
 *
 * An id whose date will not parse sorts to the back rather than to 1970, so one
 * unreadable id cannot push itself into the recent window and quietly take the
 * place of a reel that belongs there.
 */
function pkTime(igMediaId: string): number {
  const d = dateFromMediaPk(igMediaId);
  return d ? d.getTime() : -Infinity;
}

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
      // The newest few out of the reels already in hand - no second call.
      //
      // Sorted by the date inside each media id rather than trusting the order
      // they arrived in. Measured on six accounts the provider did answer
      // newest first every time, but an order that is only ever observed is not
      // an order that is promised, and the wrong six would read as a real
      // number rather than as a mistake.
      const recent = [...stubs]
        .sort((a, b) => pkTime(b.igMediaId) - pkTime(a.igMediaId))
        .slice(0, RECENT_WINDOW);
      const recentTotal = recent.reduce((sum, s) => sum + s.viewCount, 0);
      return {
        username,
        avgViews,
        videosCounted: stubs.length,
        avgViews6: recent.length ? Math.round(recentTotal / recent.length) : null,
        videosCounted6: recent.length,
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
      const graded = await gradeAlive(username, profile.mediaCount, isActive);
      return profile.via ? markedViaReels(graded, profile.via) : graded;
    }
    return null;
  } catch (err) {
    noteIfQuotaDead(err);
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
  // Whether any part of this verdict came from the reels endpoint instead of
  // the profile one. It changes nothing about the decision - the sentence
  // "user does not exist" is as explicit from one as from the other - but the
  // row says so, so the verdict can be re-examined later on its own terms.
  let viaReels: string | undefined;
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
        const graded = await gradeAlive(username, profile.mediaCount, isActive);
        return profile.via ? markedViaReels(graded, profile.via) : graded;
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
      if (profile.via) viaReels = profile.via;
    }

    console.log(`[ig-views-check] @${username} -> BANNED (confirmed ${BAN_CONFIRMATIONS}x)`);
    const how = viaReels ? ` (${viaNote(viaReels)})` : "";
    return ungraded(
      username,
      "banned",
      `not found ${BAN_CONFIRMATIONS}x, ${RECHECK_DELAY / 1000}s apart — banned or deleted${how}`,
    );
  } catch (err) {
    noteIfQuotaDead(err);
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
  return runInLane("views", () => viewsRun(usernames));
}

/* ========================================================================== *
 * Reel mode: one pasted URL, one row, one reel's views.
 *
 * Same screen, same lane, same wall and stop handling - a different question.
 * "How is this account doing" is answered by an average over a window; "how
 * did this post do" is answered by one number, and reading it off an average
 * would be wrong twice over, because the reel may not even be inside the
 * window the average is taken over.
 *
 * What it costs: the direct per-reel endpoint is one call per reel, and the
 * fallback is one reel-list call per ACCOUNT no matter how many of its reels
 * were pasted - which is why the jobs are grouped by owner before anything is
 * fetched. Seventeen lines across seventeen accounts is seventeen calls either
 * way; seventeen lines from one account is one.
 * ========================================================================== */

/**
 * Pasted lines into jobs.
 *
 * Accepts "username  https://www.instagram.com/reel/CODE/", the URL alone, and
 * the two in either order. The username is kept as the row's label and, more
 * importantly, as the account whose reel list answers the line when the direct
 * endpoint is down - so a line without one can only be answered the direct way.
 */
export function parseReelLines(lines: string[]): { jobs: ReelViewsJob[]; bad: string[] } {
  const jobs: ReelViewsJob[] = [];
  const bad: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const tokens = line.split(/[\s,]+/).filter(Boolean);
    let shortcode: string | null = null;
    let url = "";
    let label = "";

    for (const token of tokens) {
      const code = extractShortcode(token);
      if (code && !shortcode) {
        shortcode = code;
        url = /^https?:/i.test(token) ? token : `https://www.instagram.com/reel/${code}/`;
      } else if (!label) {
        label = token.replace(/^@/, "").toLowerCase();
      }
    }

    if (!shortcode) {
      bad.push(line.slice(0, 120));
      continue;
    }
    // Keyed by reel, not by line: the same URL pasted twice is one reel, and
    // paying for it twice would also put two rows on screen for one post.
    if (seen.has(shortcode)) continue;
    seen.add(shortcode);
    jobs.push({ label, shortcode, url });
  }

  return { jobs, bad };
}

/** How long ago, in the roughest unit that still means something. */
function ago(d: Date | null): string {
  if (!d) return "an unknown time ago";
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function reelRow(
  job: ReelViewsJob,
  views: number | null,
  bucket: ViewBucket,
  note?: string,
): ViewsCheckResult {
  return {
    username: job.label || job.shortcode,
    avgViews: views,
    videosCounted: views === null ? 0 : 1,
    // A single reel has no second window. Null rather than a copy of the same
    // number, which would read as two independent measurements agreeing.
    avgViews6: null,
    videosCounted6: 0,
    bucket,
    note,
    shortcode: job.shortcode,
    url: job.url,
  };
}

interface ReelGroup {
  owner: string;
  jobs: ReelViewsJob[];
}

export async function runIgReelViewsCheck(jobs: ReelViewsJob[]): Promise<void> {
  return runInLane("views", () => reelRun(jobs));
}

async function reelRun(jobs: ReelViewsJob[]): Promise<void> {
  if (progress.running) return;

  await removeFiles(WORK_FILE, RESULTS_FILE);
  await saveJson(WORK_FILE, {
    usernames: [],
    reels: jobs,
    mode: "reels",
    startedAt: Date.now(),
  } satisfies SavedViewsWork);

  await reelBatch(jobs, jobs.length, []);
}

function reelBatch(
  jobs: ReelViewsJob[],
  total: number,
  already: ViewsCheckResult[],
): Promise<void> {
  return runInLane("views", () => reelBatchWork(jobs, total, already));
}

async function reelBatchWork(
  jobs: ReelViewsJob[],
  total: number,
  already: ViewsCheckResult[],
): Promise<void> {
  if (!jobs.length) return;

  const myToken = ++runToken;
  quotaAbort = null;
  clearApiWall();
  const isActive = () => progress.running && runToken === myToken && !wallHit();

  progress = freshProgress(total, true);
  const log = new ResultLog<ViewsCheckResult>(RESULTS_FILE);

  for (const r of already) {
    progress.results.push(r);
    if (r.bucket in progress.counts) progress.counts[r.bucket]++;
  }
  progress.completed = already.length;

  const finalize = (result: ViewsCheckResult) => {
    if (!isActive()) return;
    progress.results.push(result);
    progress.counts[result.bucket]++;
    progress.completed++;
    log.add(result);
  };

  try {
    // One canary, not one probe per reel.
    //
    // The direct endpoint was refusing every code on 2026-11-24, and asking it
    // once per reel would have spent a call per row to be told the same thing
    // every time. One answer decides the route for the whole run, and it is
    // not thrown away: if it works, it is this reel's number.
    progress.current = jobs[0].shortcode;
    const canary = await withDeadline(
      probeReelViewsDirect(jobs[0].shortcode),
      TRIAGE_DEADLINE,
      () => ({ state: "inconclusive" as const, reason: "no answer in time" }),
    );
    const direct = canary.state === "ok";
    console.log(
      direct
        ? "[ig-views-check] per-reel endpoint is answering - one call per reel"
        : "[ig-views-check] per-reel endpoint not answering " +
            `(${canary.reason.slice(0, 80)}) - reading each owner's reel list instead`,
    );

    const answeredByCanary = new Set<string>();
    if (canary.state === "ok") {
      finalize(
        reelRow(jobs[0], canary.views, bucketForAvg(canary.views), `posted ${ago(canary.postedAt)}`),
      );
      answeredByCanary.add(jobs[0].shortcode);
    }

    const todo = jobs.filter((j) => !answeredByCanary.has(j.shortcode));

    // Grouped by owner so one reel-list call answers every line of the same
    // account. Lines with no username cannot be grouped at all, so each one
    // stands alone - and on the fallback route it has nowhere to look.
    const groups: ReelGroup[] = [];
    const byOwner = new Map<string, ReelGroup>();
    for (const job of todo) {
      if (!job.label) {
        groups.push({ owner: "", jobs: [job] });
        continue;
      }
      const existing = byOwner.get(job.label);
      if (existing) {
        existing.jobs.push(job);
      } else {
        const group: ReelGroup = { owner: job.label, jobs: [job] };
        byOwner.set(job.label, group);
        groups.push(group);
      }
    }

    await pool(groups, laneWorkers("views", CONCURRENCY), isActive, async (group) => {
      progress.current = group.owner || group.jobs[0].shortcode;
      const rows = direct
        ? await gradeReelsDirect(group, isActive)
        : await gradeReelsFromOwner(group);
      for (const row of rows) finalize(row);
    });
  } catch (err) {
    console.error("[ig-views-check] Reel batch error:", err);
  } finally {
    await log.flush();
    if (runToken === myToken) {
      progress.current = null;
      progress.running = false;
      progress.phase = "done";
      progress.pending = 0;
      progress.parked = [];
      progress.abortedReason = quotaAbort;
      if (progress.completed >= progress.total) {
        await removeFiles(WORK_FILE, RESULTS_FILE);
      }
      const c = progress.counts;
      console.log(
        `[ig-views-check] Reels done. <100: ${c.under100}, 100-200: ${c.mid}, 200+: ${c.over200}, ` +
          `unread: ${c.failed}`,
      );
    }
  }
}

/** The direct route: one call per reel, each with its own deadline. */
async function gradeReelsDirect(
  group: ReelGroup,
  isActive: () => boolean,
): Promise<ViewsCheckResult[]> {
  const rows: ViewsCheckResult[] = [];
  for (const job of group.jobs) {
    if (!isActive()) break;
    const probe = await withDeadline(
      probeReelViewsDirect(job.shortcode),
      TRIAGE_DEADLINE,
      () => ({ state: "inconclusive" as const, reason: `no answer within ${TRIAGE_DEADLINE / 1000}s` }),
    );
    if (probe.state === "ok") {
      rows.push(
        reelRow(job, probe.views, bucketForAvg(probe.views), `posted ${ago(probe.postedAt)}`),
      );
    } else if (probe.state === "missing") {
      // The endpoint looked and found nothing, in wording that is not a
      // complaint about looking. Still not called a ban: a reel can be deleted
      // or hidden without anything happening to the account.
      rows.push(reelRow(job, null, "failed", `reel gone - ${probe.reason.slice(0, 100)}`));
    } else {
      rows.push(reelRow(job, null, "failed", `could not read this reel: ${probe.reason.slice(0, 110)}`));
    }
  }
  return rows;
}

/**
 * The fallback route: the owner's reel list, matched by shortcode.
 *
 * A reel the list has not reached yet gets a row saying exactly that, with both
 * ages in it - the reel's and the newest one the list does carry - because
 * "not found" on its own invites the wrong conclusion. On 2026-11-24 every
 * pasted reel was 1-3 hours old and every list stopped 8 hours back; the reels
 * were fine, the list was behind.
 */
async function gradeReelsFromOwner(group: ReelGroup): Promise<ViewsCheckResult[]> {
  if (!group.owner) {
    return group.jobs.map((job) =>
      reelRow(
        job,
        null,
        "failed",
        "no username on this line, and the provider's per-reel endpoint is down - " +
          "paste it as \"username  URL\" and the account's reel list can answer it",
      ),
    );
  }

  let index: OwnerReelIndex | null = null;
  let why = `no answer within ${TRIAGE_DEADLINE / 1000}s`;
  try {
    // Widened before the race so the expiry may answer null; narrowing it to
    // OwnerReelIndex would make "no answer in time" unrepresentable.
    const work: Promise<OwnerReelIndex | null> = fetchOwnerReelIndex(
      group.owner,
      VIEWS_WINDOW,
    );
    index = await withDeadline(work, TRIAGE_DEADLINE, () => null);
  } catch (err) {
    why = (err instanceof Error ? err.message : String(err)).slice(0, 140);
  }

  if (!index) {
    return group.jobs.map((job) =>
      reelRow(job, null, "failed", `could not read @${group.owner}'s reels: ${why}`),
    );
  }

  const { views, newest, listed } = index;
  return group.jobs.map((job) => {
    const v = views.get(job.shortcode);
    if (v !== undefined) {
      return reelRow(job, v, bucketForAvg(v), `posted ${ago(dateFromShortcode(job.shortcode))}`);
    }
    if (listed === 0) {
      return reelRow(job, null, "failed", `the API listed no reels at all for @${group.owner}`);
    }
    return reelRow(
      job,
      null,
      "failed",
      `not among the ${listed} reels the API lists for @${group.owner} - this reel was ` +
        `posted ${ago(dateFromShortcode(job.shortcode))}, the newest one listed was posted ` +
        `${ago(newest?.postedAt ?? null)}; the provider's list lags behind, so try again later`,
    );
  });
}

async function viewsRun(usernames: string[]): Promise<void> {
  if (progress.running) return;

  const cleaned = [
    ...new Set(
      usernames.map((u) => u.trim().replace(/^@/, "").toLowerCase()).filter(Boolean),
    ),
  ];

  await removeFiles(WORK_FILE, RESULTS_FILE);
  await saveJson(WORK_FILE, {
    usernames: cleaned,
    startedAt: Date.now(),
  } satisfies SavedViewsWork);

  await gradeBatch(cleaned, cleaned.length, []);
}

/**
 * The two passes themselves, shared by a fresh run and a resumed one.
 *
 * `total` and `already` exist so a resume can show the whole job rather than
 * just its tail: the accounts answered before the restart are replayed into the
 * results, and only the unanswered ones are actually paid for again.
 */
/**
 * The lane is marked around the WORK, not around the call that starts it.
 * Every resume hands this off with `void` and returns at once, so a mark taken
 * on the entry point would be dropped while the run carried on untagged - and
 * a live check sitting beside it would never be put on its share. Nesting is
 * harmless: the lane is counted, not a flag.
 */
function gradeBatch(
  cleaned: string[],
  total: number,
  already: ViewsCheckResult[],
): Promise<void> {
  return runInLane("views", () => gradeBatchWork(cleaned, total, already));
}

async function gradeBatchWork(
  cleaned: string[],
  total: number,
  already: ViewsCheckResult[],
): Promise<void> {
  const myToken = ++runToken;
  quotaAbort = null;
  clearApiWall();
  const isActive = () => progress.running && runToken === myToken && !wallHit();

  progress = freshProgress(total, true);
  const log = new ResultLog<ViewsCheckResult>(RESULTS_FILE);

  for (const r of already) {
    progress.results.push(r);
    if (r.bucket in progress.counts) progress.counts[r.bucket]++;
  }
  progress.completed = already.length;

  const finalize = (result: ViewsCheckResult) => {
    if (!isActive()) return;
    progress.results.push(result);
    progress.counts[result.bucket]++;
    progress.completed++;
    log.add(result);
  };

  try {
    const jobs: Job[] = cleaned.map((username) => ({ username }));

    const parked: Job[] = [];
    await pool(jobs, laneWorkers("views", CONCURRENCY), isActive, async (job) => {
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

    // Pass 2 — the verdict. Several accounts at once, but each one still has to
    // produce BAN_CONFIRMATIONS "not found" answers RECHECK_DELAY apart before
    // it is called banned. The per-minute ceiling that made parallel probing
    // dangerous is enforced in rate-limit.ts now, not approximated by keeping
    // this pass slow.
    if (parked.length && isActive()) {
      progress.phase = "confirming";
      console.log(
        `[ig-views-check] Pass 2: confirming  accounts,  at a time`,
      );
      await pool(parked, laneWorkers("views", CONFIRM_CONCURRENCY), isActive, async (job) => {
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
    await log.flush();
    if (runToken === myToken) {
      progress.current = null;
      progress.running = false;
      progress.phase = "done";
      progress.pending = 0;
      progress.parked = [];
      progress.abortedReason = quotaAbort;
      if (progress.completed >= progress.total) {
        await removeFiles(WORK_FILE, RESULTS_FILE);
      }
      const c = progress.counts;
      console.log(
        `[ig-views-check] Done. <100: ${c.under100}, 100-200: ${c.mid}, 200+: ${c.over200}, ` +
          `banned: ${c.banned}, no posts: ${c.noposts}, no reels: ${c.noreels}, failed: ${c.failed}`,
      );
    }
  }
}


/** What an interrupted views check left behind, if anything. */
export async function getResumableViewsCheck(): Promise<ResumableViewsCheck | null> {
  if (progress.running) return null;
  const saved = await loadJson<SavedViewsWork>(WORK_FILE);
  if (!saved) return null;
  const total =
    saved.mode === "reels" ? saved.reels?.length ?? 0 : saved.usernames?.length ?? 0;
  if (!total) return null;
  const done = await readLines<ViewsCheckResult>(RESULTS_FILE);
  const remaining = total - done.length;
  if (remaining <= 0) return null;
  return { total, done: done.length, remaining };
}

/**
 * Continue where a restart cut the list off. Accounts already graded are
 * replayed, not re-fetched; only the ones never answered for cost anything.
 * An account that was parked for the confirmation pass when the process died
 * is simply graded again from the top, which is correct — it never got a
 * verdict, and the first pass is what produces one.
 */
export async function resumeIgViewsCheck(): Promise<boolean> {
  return runInLane("views", viewsResume);
}

async function viewsResume(): Promise<boolean> {
  if (progress.running) return false;

  const saved = await loadJson<SavedViewsWork>(WORK_FILE);
  if (!saved) return false;

  // A reel run resumes by reel. Answered rows are matched on the shortcode,
  // not on the username, because reel mode puts the same username on as many
  // rows as there were URLs for it - matching by name would drop the rest.
  if (saved.mode === "reels") {
    const reels = saved.reels ?? [];
    if (!reels.length) return false;
    const done = await readLines<ViewsCheckResult>(RESULTS_FILE);
    const answered = new Set(done.map((r) => r.shortcode).filter(Boolean));
    const remaining = reels.filter((j) => !answered.has(j.shortcode));
    if (!remaining.length) {
      await removeFiles(WORK_FILE, RESULTS_FILE);
      return false;
    }
    console.log(
      `[ig-views-check] Resuming reels: ${done.length} already read, ${remaining.length} to go`,
    );
    void reelBatch(remaining, reels.length, done);
    return true;
  }

  if (!saved.usernames?.length) return false;

  const done = await readLines<ViewsCheckResult>(RESULTS_FILE);
  const answered = new Set(done.map((r) => r.username.toLowerCase()));
  const remaining = saved.usernames.filter((u) => !answered.has(u.toLowerCase()));

  if (!remaining.length) {
    await removeFiles(WORK_FILE, RESULTS_FILE);
    return false;
  }

  console.log(
    `[ig-views-check] Resuming: ${done.length} already graded, ${remaining.length} to go`,
  );
  void gradeBatch(remaining, saved.usernames.length, done);
  return true;
}
