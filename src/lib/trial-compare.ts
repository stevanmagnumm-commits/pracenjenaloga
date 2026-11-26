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
import {
  recallOrganic,
  rememberOrganic,
  type OrganicReel,
} from "./organic-cache";
import { runInLane, laneWorkers } from "./api-lanes";
import {
  ORGANIC_WINDOW,
  ORGANIC_TTL_MS,
  bucketForDiff,
  diffPercent,
  emptyTrialCounts,
  type TrialBucket,
  type TrialCounts,
} from "./trial-buckets";

/* ========================================================================== *
 * Trial reels against the account's own organic posts.
 *
 * The question is not "how did this reel do" - the Views Checker answers that
 * - but "did the trial reels do better or worse than what this account
 * normally pulls". A view count alone cannot answer it: 900 views is good on
 * an account that averages 300 and poor on one that averages 3,000. So every
 * trial reel is measured against the same account's last ORGANIC_WINDOW
 * organic reels, and the row carries the gap as a percentage.
 *
 * The account is read OFF THE REEL
 * --------------------------------
 * Nothing has to be typed but the URL. The per-reel answer carries the owner,
 * so the account a reel belongs to is a fact the lookup returns rather than
 * something the paste has to get right. A username typed in front of a URL is
 * treated as a hint for where to look first, never as the answer: if the reel
 * turns out to belong to someone else, the row is re-attributed to the owner
 * the reel reports and the baseline is taken from THAT account. A typo in a
 * pasted name used to mean a comparison against a stranger's numbers, silently.
 *
 * Why two providers, and which does what
 * --------------------------------------
 * Neither one can answer this alone, which is why this is a section of its own
 * rather than a column on an existing screen.
 *
 *   - The MAIN plan (get_ig_user_reels.php, a million calls a month) lists an
 *     account's reels with their view counts. ONE call gives the entire
 *     organic baseline. It cannot see trial reels: a trial reel is served to
 *     non-followers and does not sit on the profile, which is exactly what the
 *     earlier reel-mode work ran into when seventeen pasted trial reels were
 *     absent from every list while their neighbours listed fine.
 *
 *   - INSTAGRAM-LOOTER2 (75,000 calls a month) reads any reel by URL, trial
 *     ones included, one call per reel, and names its owner. It cannot give a
 *     baseline: six organic reels would be six calls where the main plan
 *     spends one.
 *
 * So the normal cost of a trial reel is one call on each plan's side of the
 * fence: one per ACCOUNT for the baseline, one per REEL for the reel. A pasted
 * reel that does turn up on the profile list is free - its number is already
 * in the baseline call - which is why a typed username is still worth
 * accepting even though nothing needs it.
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
  /**
   * When the baseline was fetched, and whether this run fetched it.
   *
   * On screen rather than implied: a comparison against yesterday's numbers is
   * a different statement from a comparison against this minute's, and which
   * one you are reading must not depend on remembering whether the Views
   * Checker happened to run earlier.
   */
  baselineAt: number | null;
  baselineReused: boolean;
}

export type TrialPhase = "idle" | "resolving" | "comparing" | "done";

export interface TrialCompareProgress {
  total: number;
  /** Reels whose owner and view count are settled - the first pass. */
  resolved: number;
  /** Reels whose account has been graded - the second pass. */
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
 * How many reels, then accounts, are worked at once.
 *
 * Six rather than the Views Checker's forty, because the shape of the work is
 * different: the per-reel plan's month is 75,000 rather than a million, and
 * the looter semaphore (eight) paces it anyway.
 */
const CONCURRENCY = 6;

/** A hard ceiling on how long one unit of work may hold a worker. Same
 *  reasoning as the Views Checker's: an un-cancellable hang must not freeze
 *  the whole run. */
const DEADLINE = 180_000;

function freshProgress(total: number, running: boolean): TrialCompareProgress {
  return {
    total,
    resolved: 0,
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

/** A spent per-reel plan is not a hiccup: grinding on would write a wall of
 *  identical failures and the plan is gone either way. */
function noteIfPerReelSpent(probe: ReelProbe): void {
  if (quotaAbort) return;
  if (probe.state !== "inconclusive") return;
  if (!probe.reason.includes(PER_REEL_QUOTA_GONE)) return;
  quotaAbort =
    "The per-reel API plan is spent - run stopped. Rows already finished are " +
    "valid; the rest are simply unchecked.";
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

/** One reel after the first pass: whose it is, and what it pulled. */
interface Measured {
  job: ReelViewsJob;
  /** The owner the REEL reports, or the typed hint when nothing could be read. */
  owner: string | null;
  views: number | null;
  note: string;
}

/**
 * @param fresh Ignore the cache and fetch every baseline again. The default is
 *   to reuse anything newer than ORGANIC_TTL_MS, which is almost always what
 *   is wanted; this is the escape hatch for when it is not.
 */
export async function runTrialCompare(
  jobs: ReelViewsJob[],
  fresh = false,
): Promise<void> {
  return runInLane("views", () => trialRun(jobs, fresh));
}

async function trialRun(jobs: ReelViewsJob[], fresh: boolean): Promise<void> {
  if (progress.running) return;

  const myToken = ++runToken;
  quotaAbort = null;
  clearApiWall();
  progress = freshProgress(jobs.length, true);
  const isActive = () => progress.running && runToken === myToken && !wallHit();

  // One lookup per account however many times it is asked for, shared between
  // workers as a promise rather than a result - two reels of the same account
  // resolve at the same moment, and caching only the answer would let both
  // start their own call before either finished.
  const baselines = new Map<string, Promise<Baseline>>();

  function baselineFor(username: string): Promise<Baseline> {
    const have = baselines.get(username);
    if (have) return have;
    const work = fetchBaseline(username, fresh);
    baselines.set(username, work);
    return work;
  }

  try {
    /* ------------------------------------------------------------------ *
     * Pass 1: whose reel is this, and what did it pull.
     *
     * A typed username is a hint about where to look first, nothing more.
     * When it is right AND the reel is on that account's list, the number
     * comes out of a call that had to be made anyway and the per-reel plan
     * is not touched at all. Every other path asks the reel itself, which
     * answers with the owner's name attached - so the account is read off
     * the reel rather than off the paste.
     * ------------------------------------------------------------------ */
    const measured: Measured[] = [];

    await pool(jobs, laneWorkers("views", CONCURRENCY), isActive, async (job) => {
      progress.current = job.label || job.shortcode;

      if (job.label) {
        const base = await withDeadline(baselineFor(job.label), DEADLINE, () =>
          emptyBaseline("no answer in time"),
        );
        const listed = base.reels.find((r) => r.shortcode === job.shortcode);
        if (listed) {
          // On that account's own list, so the typed name is confirmed by the
          // thing itself - there is nothing left for a lookup to tell us.
          measured.push({
            job,
            owner: job.label,
            views: listed.views,
            note:
              "on the profile list - no per-reel call spent" +
              (base.reused ? ", read from the saved list" : ""),
          });
          progress.resolved++;
          return;
        }
      }

      const probe = await withDeadline(probeReelViews(job.shortcode), DEADLINE, () => ({
        state: "inconclusive" as const,
        reason: `no answer within ${DEADLINE / 1000}s`,
      }));
      noteIfPerReelSpent(probe);

      if (probe.state === "ok") {
        const owner = probe.username || job.label || null;
        const moved =
          job.label && probe.username && probe.username !== job.label
            ? ` - pasted as @${job.label}, but the reel says it is @${probe.username}, so it is compared against @${probe.username}`
            : "";
        measured.push({
          job,
          owner,
          views: probe.views,
          note:
            "read by URL - not on the profile list, which is what a trial reel looks like" +
            moved,
        });
        progress.resolved++;
        return;
      }

      // Unreadable. The typed name, if there was one, is all that is left to
      // file it under; without one the row has no account at all and says so.
      measured.push({
        job,
        owner: job.label || null,
        views: null,
        note: probe.reason.slice(0, 140),
      });
      progress.resolved++;
    });

    if (!isActive()) return;

    /* ------------------------------------------------------------------ *
     * Pass 2: one row per account.
     *
     * Grouped by the owner the REEL reported, so several trial reels of the
     * same account become one row with one average - and so a re-attributed
     * reel lands with the account it actually belongs to.
     * ------------------------------------------------------------------ */
    progress.phase = "comparing";

    const groups = new Map<string, Measured[]>();
    const orphans: Measured[] = [];
    for (const m of measured) {
      if (!m.owner) {
        orphans.push(m);
        continue;
      }
      const have = groups.get(m.owner);
      if (have) have.push(m);
      else groups.set(m.owner, [m]);
    }

    const finalize = (row: TrialCompareResult, lines: number) => {
      if (runToken !== myToken) return;
      progress.results.push(row);
      progress.counts[row.bucket]++;
      progress.completed += lines;
    };

    await pool(
      [...groups.entries()],
      laneWorkers("views", CONCURRENCY),
      isActive,
      async ([owner, reels]) => {
        progress.current = owner;
        const row = await withDeadline(
          buildRow(owner, reels, baselineFor),
          DEADLINE,
          () => failedRow(owner, reels, `no answer within ${DEADLINE / 1000}s`),
        );
        finalize(row, reels.length);
      },
    );

    for (const m of orphans) {
      finalize(
        {
          username: m.job.shortcode,
          trialAvg: null,
          trialCount: 0,
          organicAvg: null,
          organicCount: 0,
          diffPct: null,
          bucket: "failed",
          note:
            "the reel could not be read, so there is no account to compare it " +
            `against (${m.note})`,
          reels: [
            {
              shortcode: m.job.shortcode,
              url: m.job.url,
              views: null,
              note: m.note,
            },
          ],
          organic: [],
          baselineAt: null,
          baselineReused: false,
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

function failedRow(
  owner: string,
  reels: Measured[],
  why: string,
): TrialCompareResult {
  return {
    username: owner,
    trialAvg: null,
    trialCount: 0,
    organicAvg: null,
    organicCount: 0,
    diffPct: null,
    bucket: "failed",
    note: why,
    reels: reels.map((m) => ({
      shortcode: m.job.shortcode,
      url: m.job.url,
      views: null,
      note: why,
    })),
    organic: [],
    baselineAt: null,
    baselineReused: false,
  };
}

/* -------------------------------------------------------------------------- *
 * The baseline, from the saved list when it is recent enough.
 *
 * Both tools that fetch an account's reels put them in organic-cache.ts, so a
 * Views Checker run over a list of accounts has already bought every baseline
 * a paste of their trial reels will ask for. Within ORGANIC_TTL_MS that answer
 * is reused; past it, or when the run was asked for fresh numbers, the call is
 * made and the result goes back into the cache for the next reader.
 *
 * Every row carries where its own baseline came from, so this never changes
 * what a number means without saying so.
 * -------------------------------------------------------------------------- */

interface Baseline {
  reels: OrganicReel[];
  /** When the list was fetched, in epoch ms, or null when it never was. */
  at: number | null;
  /** True when this run did not pay for it. */
  reused: boolean;
  /** Why there is nothing here, when there is nothing. */
  why: string;
}

function emptyBaseline(why: string): Baseline {
  return { reels: [], at: null, reused: false, why };
}

async function fetchBaseline(username: string, fresh: boolean): Promise<Baseline> {
  if (!fresh) {
    const hit = await recallOrganic(username, ORGANIC_TTL_MS);
    if (hit) return { reels: hit.reels, at: hit.at, reused: true, why: "" };
  }

  try {
    const stubs = await fetchAllStubs(username, ORGANIC_WINDOW * 2);
    // Sorted here, before it is cached, so the saved list and a freshly
    // fetched one are in the same order and a cached run cannot quietly
    // produce a different six than an uncached one.
    const reels: OrganicReel[] = [...stubs]
      .sort((a, b) => newestFirst(a.shortcode, b.shortcode))
      .map((s) => ({ shortcode: s.shortcode, views: s.viewCount }));
    if (reels.length) void rememberOrganic(username, reels);
    return { reels, at: Date.now(), reused: false, why: "" };
  } catch (err) {
    noteIfQuotaDead(err);
    return emptyBaseline(
      (err instanceof Error ? err.message : String(err)).slice(0, 120),
    );
  }
}

/**
 * One account's row: its baseline, its trial reels, and the gap.
 *
 * The baseline call is usually already in flight or finished by now - pass 1
 * asked for it for any line that carried a username - so this is free for
 * those and one call for an account that was discovered from a bare URL.
 */
async function buildRow(
  owner: string,
  reels: Measured[],
  baselineFor: (u: string) => Promise<Baseline>,
): Promise<TrialCompareResult> {
  const trialCodes = new Set(reels.map((m) => m.job.shortcode));
  const base = await baselineFor(owner);
  const listWhy = base.why;

  // The baseline is the account's own recent posts with anything pasted as a
  // trial reel taken out of it. Trial reels are normally absent from the list
  // anyway; when one is not, counting it on both sides would quietly drag the
  // comparison toward zero.
  const organic: OrganicReelRow[] = base.reels
    .filter((r) => !trialCodes.has(r.shortcode))
    .slice(0, ORGANIC_WINDOW);

  const rows: TrialReelRow[] = reels.map((m) => ({
    shortcode: m.job.shortcode,
    url: m.job.url,
    views: m.views,
    note: m.note,
  }));

  const trialAvg = mean(
    rows.map((r) => r.views).filter((v): v is number => v !== null),
  );
  const trialCount = rows.filter((r) => r.views !== null).length;
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
    username: owner,
    trialAvg,
    trialCount,
    organicAvg,
    organicCount: organic.length,
    diffPct,
    bucket: bucketForDiff(diffPct),
    note,
    reels: rows,
    organic,
    baselineAt: base.at,
    baselineReused: base.reused,
  };
}
