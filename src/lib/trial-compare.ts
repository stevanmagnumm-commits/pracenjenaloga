import {
  fetchAllStubs,
  probeReelViews,
  dateFromShortcode,
  apiWallReason,
  standingApiWall,
  clearApiWall,
  PER_REEL_QUOTA_GONE,
  type ReelProbe,
} from "./instagram-api";
import { parseReelLines, type ReelViewsJob } from "./ig-views-check";
import { runInLane, laneWorkers } from "./api-lanes";
import {
  ORGANIC_WINDOW,
  bucketForDiff,
  diffPercent,
  emptyTrialCounts,
  type TrialBucket,
  type TrialCounts,
} from "./trial-buckets";

/* ========================================================================== *
 * Trial reels against the account's own organic posts.
 *
 * The question this answers is not "how did this reel do" - the Views Checker
 * already answers that - but "did the trial reels do better or worse than what
 * this account normally pulls". A view count on its own cannot answer it: 900
 * views is good on an account that averages 300 and poor on one that averages
 * 3,000. So every trial reel is measured against the same account's last
 * ORGANIC_WINDOW organic reels, and the row carries the gap between the two as
 * a percentage.
 *
 * Why two providers, and which does what
 * --------------------------------------
 * Neither one can answer this alone, which is the whole reason this section
 * needed building rather than being a column on an existing screen.
 *
 *   - The MAIN plan (get_ig_user_reels.php, a million calls a month) lists an
 *     account's reels with their view counts. ONE call per account gives the
 *     entire organic baseline. It cannot see trial reels: a trial reel is
 *     served to non-followers and does not sit on the profile, which is
 *     exactly why the earlier reel-mode work found seventeen pasted trial
 *     reels absent from every list while the same key listed their neighbours
 *     fine.
 *
 *   - INSTAGRAM-LOOTER2 (75,000 calls a month) reads any reel by URL, trial
 *     ones included, one call per reel. It cannot give a baseline: asking it
 *     for six organic reels would be six calls where the main plan spends one.
 *
 * So: one main-plan call per ACCOUNT for the baseline, one looter call per
 * TRIAL REEL. An account with four trial reels costs 1 + 4. And when a pasted
 * reel does turn up on the profile list after all, its number is taken from
 * there and no looter call is spent on it.
 *
 * Both numbers are the same measurement - play_count on the main plan,
 * video_play_count on looter2 - so the percentage is not comparing two
 * different definitions of a view.
 * ========================================================================== */

/** One trial reel inside a row. */
export interface TrialReelRow {
  shortcode: string;
  url: string;
  /** Null when neither provider could read it; `note` then says why. */
  views: number | null;
  /** Where the number came from, or why there is none. */
  note: string;
}

/** One organic reel the baseline was taken over. */
export interface OrganicReelRow {
  shortcode: string;
  views: number;
}

export interface TrialCompareResult {
  username: string;
  /** Mean views of the trial reels that could be read. */
  trialAvg: number | null;
  /** How many trial reels that average is actually based on. */
  trialCount: number;
  /** Mean views of the last ORGANIC_WINDOW organic reels on the profile. */
  organicAvg: number | null;
  organicCount: number;
  /** Trial against organic, in percent. +40 = the trial reels pulled 40% more. */
  diffPct: number | null;
  bucket: TrialBucket;
  /** Set whenever the row carries no percentage, explaining which side failed. */
  note?: string;
  reels: TrialReelRow[];
  organic: OrganicReelRow[];
}

export type TrialPhase = "idle" | "resolving" | "comparing" | "done";

export interface TrialCompareProgress {
  total: number;
  completed: number;
  current: string | null;
  phase: TrialPhase;
  running: boolean;
  counts: TrialCounts;
  results: TrialCompareResult[];
  /** Set when the run stopped itself - a spent plan, a walled API. */
  abortedReason: string | null;
  startedAt: number | null;
}

/**
 * How many accounts are worked at once.
 *
 * Six rather than the Views Checker's forty, because the shape of the work is
 * different: each account here fires one main-plan call and then a burst of
 * per-reel calls on a plan whose month is 75,000 rather than a million. Six
 * accounts of four reels each is twenty-four per-reel calls in flight, which
 * the looter semaphore (eight) then paces anyway.
 */
const CONCURRENCY = 6;

/** A hard ceiling on how long one account may hold a worker. Same reasoning as
 *  the Views Checker's: an un-cancellable hang must not freeze the whole run. */
const ACCOUNT_DEADLINE = 180_000;

function freshProgress(total: number, running: boolean): TrialCompareProgress {
  return {
    total,
    completed: 0,
    current: null,
    phase: running ? "resolving" : "idle",
    running,
    counts: emptyTrialCounts(),
    results: [],
    abortedReason: null,
    startedAt: running ? Date.now() : null,
  };
}

let progress: TrialCompareProgress = freshProgress(0, false);
let runToken = 0;
let quotaAbort: string | null = null;

export function getTrialCompareProgress(): TrialCompareProgress {
  return progress;
}

export function stopTrialCompare(): void {
  if (progress.running) {
    progress.running = false;
    progress.current = null;
    progress.phase = "done";
    console.log("[trial-compare] Stopped by user");
  }
}

/**
 * Whether the API has walled us, checked out in the open rather than inside a
 * catch - a swallowed error is exactly how an outage turns into a screen full
 * of confident-looking zeroes.
 */
function wallHit(): boolean {
  if (quotaAbort) return true;
  const wall = standingApiWall();
  if (!wall) return false;
  quotaAbort = wall;
  console.error("[trial-compare] ABORT: " + wall);
  return true;
}

function noteIfQuotaDead(err: unknown): void {
  if (quotaAbort) return;
  const wall = apiWallReason(err);
  if (!wall) return;
  quotaAbort = wall;
  console.error("[trial-compare] ABORT: " + quotaAbort);
}

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
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

const mean = (xs: number[]): number | null =>
  xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

/** Newest first, by the posting time hidden inside the shortcode. */
function newestFirst(a: string, b: string): number {
  const at = dateFromShortcode(a)?.getTime() ?? 0;
  const bt = dateFromShortcode(b)?.getTime() ?? 0;
  return bt - at;
}

/** Parsing is the Views Checker's, deliberately: one rule for what counts as a
 *  reel URL, living with the code that has to go and fetch it. */
export function parseTrialLines(lines: string[]): {
  jobs: ReelViewsJob[];
  bad: string[];
} {
  return parseReelLines(lines);
}

interface Group {
  owner: string;
  jobs: ReelViewsJob[];
}

export async function runTrialCompare(jobs: ReelViewsJob[]): Promise<void> {
  return runInLane("views", () => trialRun(jobs));
}

async function trialRun(jobs: ReelViewsJob[]): Promise<void> {
  if (progress.running) return;

  const myToken = ++runToken;
  quotaAbort = null;
  clearApiWall();
  progress = freshProgress(jobs.length, true);
  const isActive = () =>
    progress.running && runToken === myToken && !wallHit();

  try {
    /* ---------------------------------------------------------------- *
     * Phase 1: whose reel is this?
     *
     * A line pasted as a bare URL has no account on it, and without an
     * account there is nothing to compare against - the baseline IS the
     * account. The per-reel provider returns the owner along with the view
     * count, so one call does both jobs and the answer is kept so the second
     * phase does not buy it again.
     * ---------------------------------------------------------------- */
    const probed = new Map<string, ReelProbe>();
    const anonymous = jobs.filter((j) => !j.label);

    if (anonymous.length) {
      progress.phase = "resolving";
      await pool(anonymous, laneWorkers("views", CONCURRENCY), isActive, async (job) => {
        progress.current = job.shortcode;
        const probe = await withDeadline(
          probeReelViews(job.shortcode),
          ACCOUNT_DEADLINE,
          () => ({
            state: "inconclusive" as const,
            reason: `no answer within ${ACCOUNT_DEADLINE / 1000}s`,
          }),
        );
        probed.set(job.shortcode, probe);
        if (probe.state === "ok" && probe.username) job.label = probe.username;
        if (
          probe.state === "inconclusive" &&
          probe.reason.includes(PER_REEL_QUOTA_GONE) &&
          !quotaAbort
        ) {
          quotaAbort =
            "The per-reel API plan is spent - run stopped. Rows already " +
            "finished are valid; the rest are simply unchecked.";
          console.error("[trial-compare] ABORT: " + quotaAbort);
        }
      });
    }

    if (!isActive()) return;

    /* ---------------------------------------------------------------- *
     * Phase 2: one row per account.
     *
     * Grouped by owner first, because the baseline costs one call per
     * account however many of its reels were pasted - and because the
     * average the user asked for is an average per account, not per line.
     * ---------------------------------------------------------------- */
    progress.phase = "comparing";
    const groups: Group[] = [];
    const byOwner = new Map<string, Group>();
    const orphans: ReelViewsJob[] = [];

    for (const job of jobs) {
      if (!job.label) {
        // Still nameless after phase 1: the provider could not say whose reel
        // it is, so there is no account to compare it against. It gets a row
        // of its own saying exactly that, rather than being dropped.
        orphans.push(job);
        continue;
      }
      const existing = byOwner.get(job.label);
      if (existing) {
        existing.jobs.push(job);
      } else {
        const group: Group = { owner: job.label, jobs: [job] };
        byOwner.set(job.label, group);
        groups.push(group);
      }
    }

    const finalize = (row: TrialCompareResult, lines: number) => {
      if (runToken !== myToken) return;
      progress.results.push(row);
      progress.counts[row.bucket]++;
      progress.completed += lines;
    };

    await pool(groups, laneWorkers("views", CONCURRENCY), isActive, async (group) => {
      progress.current = group.owner;
      const row = await withDeadline(
        compareAccount(group, probed),
        ACCOUNT_DEADLINE,
        () => failedRow(group, `no answer within ${ACCOUNT_DEADLINE / 1000}s`),
      );
      finalize(row, group.jobs.length);
    });

    for (const job of orphans) {
      const why = probed.get(job.shortcode);
      finalize(
        {
          username: job.shortcode,
          trialAvg: null,
          trialCount: 0,
          organicAvg: null,
          organicCount: 0,
          diffPct: null,
          bucket: "failed",
          note:
            "no account on this line and the reel lookup could not say whose " +
            `it is${why && why.state !== "ok" ? ` (${why.reason.slice(0, 90)})` : ""}` +
            " - add the username in front of the URL and it can be compared",
          reels: [
            {
              shortcode: job.shortcode,
              url: job.url,
              views: null,
              note: "owner unknown",
            },
          ],
          organic: [],
        },
        1,
      );
    }
  } catch (err) {
    noteIfQuotaDead(err);
    console.error("[trial-compare] Run error:", err);
  } finally {
    if (runToken === myToken) {
      progress.current = null;
      progress.running = false;
      progress.phase = "done";
      progress.abortedReason = quotaAbort;
      const c = progress.counts;
      console.log(
        `[trial-compare] Done. worse: ${c.worse}, same: ${c.same}, ` +
          `better: ${c.better}, no comparison: ${c.failed}`,
      );
    }
  }
}

function failedRow(group: Group, why: string): TrialCompareResult {
  return {
    username: group.owner,
    trialAvg: null,
    trialCount: 0,
    organicAvg: null,
    organicCount: 0,
    diffPct: null,
    bucket: "failed",
    note: why,
    reels: group.jobs.map((j) => ({
      shortcode: j.shortcode,
      url: j.url,
      views: null,
      note: why,
    })),
    organic: [],
  };
}

/**
 * One account: its organic baseline, its trial reels, and the gap.
 *
 * Order matters for cost. The profile list is fetched first and serves two
 * purposes at once - it is the baseline, and it is also a free answer for any
 * pasted reel that happens to be on it. Only what is left over is bought from
 * the per-reel provider.
 */
async function compareAccount(
  group: Group,
  probed: Map<string, ReelProbe>,
): Promise<TrialCompareResult> {
  const trialCodes = new Set(group.jobs.map((j) => j.shortcode));

  // Twice the window, one page, one call: pinned reels are dropped by
  // fetchAllStubs and a pasted reel may occupy a slot too, so asking for
  // exactly six would sometimes come back with four.
  let stubs: Awaited<ReturnType<typeof fetchAllStubs>> = [];
  let listWhy = "";
  try {
    stubs = await fetchAllStubs(group.owner, ORGANIC_WINDOW * 2);
  } catch (err) {
    noteIfQuotaDead(err);
    listWhy = (err instanceof Error ? err.message : String(err)).slice(0, 120);
  }

  const stubViews = new Map(stubs.map((s) => [s.shortcode, s.viewCount]));

  // The baseline is the account's own recent posts, with anything pasted as a
  // trial reel taken out of it. Trial reels are normally absent from the list
  // anyway; when one is not, counting it on both sides would quietly drag the
  // comparison toward zero.
  const organic: OrganicReelRow[] = stubs
    .filter((s) => !trialCodes.has(s.shortcode))
    .sort((a, b) => newestFirst(a.shortcode, b.shortcode))
    .slice(0, ORGANIC_WINDOW)
    .map((s) => ({ shortcode: s.shortcode, views: s.viewCount }));

  const reels: TrialReelRow[] = [];
  for (const job of group.jobs) {
    const listed = stubViews.get(job.shortcode);
    if (listed !== undefined) {
      reels.push({
        shortcode: job.shortcode,
        url: job.url,
        views: listed,
        note: "on the profile list - no per-reel call spent",
      });
      continue;
    }

    const probe =
      probed.get(job.shortcode) ??
      (await withDeadline(probeReelViews(job.shortcode), ACCOUNT_DEADLINE, () => ({
        state: "inconclusive" as const,
        reason: `no answer within ${ACCOUNT_DEADLINE / 1000}s`,
      })));
    probed.set(job.shortcode, probe);

    if (probe.state === "ok") {
      reels.push({
        shortcode: job.shortcode,
        url: job.url,
        views: probe.views,
        note: "read by URL - not on the profile list, which is what a trial reel looks like",
      });
      continue;
    }

    if (
      probe.state === "inconclusive" &&
      probe.reason.includes(PER_REEL_QUOTA_GONE) &&
      !quotaAbort
    ) {
      quotaAbort =
        "The per-reel API plan is spent - run stopped. Rows already finished " +
        "are valid; the rest are simply unchecked.";
      console.error("[trial-compare] ABORT: " + quotaAbort);
    }

    reels.push({
      shortcode: job.shortcode,
      url: job.url,
      views: null,
      note: probe.reason.slice(0, 140),
    });
  }

  const trialAvg = mean(
    reels.map((r) => r.views).filter((v): v is number => v !== null),
  );
  const trialCount = reels.filter((r) => r.views !== null).length;
  const organicAvg = mean(organic.map((o) => o.views));
  const diffPct = diffPercent(trialAvg, organicAvg);

  // Said plainly, and only about the side that actually failed. "Could not
  // compare" with no reason is the kind of row that gets re-run forever.
  let note: string | undefined;
  if (trialAvg === null && organicAvg === null) {
    note = `neither side could be read${listWhy ? ` (the profile list said: ${listWhy})` : ""}`;
  } else if (trialAvg === null) {
    note = "none of the trial reels could be read";
  } else if (organicAvg === null) {
    note = listWhy
      ? `no organic baseline: ${listWhy}`
      : "no organic reels on the profile to compare against";
  } else if (organicAvg <= 0) {
    note = "the organic baseline is zero views, so there is no percentage to take";
  }

  return {
    username: group.owner,
    trialAvg,
    trialCount,
    organicAvg,
    organicCount: organic.length,
    diffPct,
    bucket: bucketForDiff(diffPct),
    note,
    reels,
    organic,
  };
}
