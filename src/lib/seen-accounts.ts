import { appendLines, readLines, saveJsonl } from "./run-state";

/**
 * Every account the Link Finder has ever answered for, so it is never paid for
 * twice.
 *
 * Measured across two consecutive runs: of the 49,902 accounts checked on the
 * second, 13,296 — one in four — had already been checked on the first. At the
 * run's average of 2.4 calls per account that is ~31,900 calls, 27% of its
 * whole budget, spent asking questions that were already answered.
 *
 * Unlike every other saving available here, this one costs nothing: no account
 * is skipped that would have produced a new result, because the result is
 * already in hand.
 *
 * A verdict is held for seven days and then forgotten, so the account comes
 * back into a later run as new rather than being excluded on the strength of a
 * stale answer. Nothing is remembered forever: an account with an empty bio
 * today may add a link, one just under the follower floor may grow past it, and
 * a week is short enough that neither goes unnoticed for long.
 *
 * The saving therefore applies to runs within a week of each other, which is
 * how these are actually run — the two that were measured were a day apart.
 */

const DAY = 86_400_000;

/** How long a verdict is trusted. One week, for every bucket alike. */
const TTL_MS = Math.max(1, Number(process.env.IG_SEEN_TTL_DAYS) || 7) * DAY;

/**
 * "failed" is deliberately absent: it is the absence of an answer, not an
 * answer, so it is never recorded and never suppresses a later attempt.
 */
/**
 * Verdicts that mean "this account is running a funnel".
 *
 * These never expire. The question the whole tool exists to answer has been
 * answered for them, and asking again a week later costs calls to learn
 * something already known — the account does not stop having a funnel. On a
 * repeat they go straight into the good pile, marked as carried over rather
 * than freshly checked.
 */
const GOOD_BUCKETS = new Set(["bio", "signal", "hlname", "story"]);

/**
 * The rest do expire, and that is the point of the week: an empty bio may gain
 * a link, an account under the follower floor may grow past it. Only a verdict
 * that can still change is worth re-checking.
 */
const CACHED_BUCKETS = new Set([
  ...GOOD_BUCKETS,
  "wrongscript",
  "outofrange",
  "none",
  "private",
]);

/** True when this verdict already qualified the account. */
export function wasGood(bucket: string): boolean {
  return GOOD_BUCKETS.has(bucket);
}

const FILE = "seen-accounts.jsonl";

interface SeenRow {
  /** username, lowercased */
  u: string;
  /** bucket it was filed under */
  b: string;
  /** epoch ms */
  t: number;
}

let store: Map<string, SeenRow> | null = null;
let loading: Promise<void> | null = null;
/** Lines read from disk, to decide when the append log is worth compacting. */
let linesOnDisk = 0;

async function load(): Promise<void> {
  if (store) return;
  if (loading) return loading;
  loading = (async () => {
    const rows = await readLines<SeenRow>(FILE);
    const cutoff = Date.now() - TTL_MS;
    const map = new Map<string, SeenRow>();
    let expired = 0;
    // Append-only, so a later line supersedes an earlier one for the same user.
    for (const r of rows) {
      if (!r || typeof r.u !== "string") continue;
      // Dropped on the way in, not merely ignored on lookup. With a fixed
      // expiry the log would otherwise grow without bound, and every restart
      // would pay to read a year of answers nobody is allowed to use.
      if (!GOOD_BUCKETS.has(r.b) && !(r.t > cutoff)) {
        expired++;
        map.delete(r.u);
        continue;
      }
      map.set(r.u, r);
    }
    linesOnDisk = rows.length;
    store = map;
    console.log(
      `[seen] ${map.size} accounts within ${TTL_MS / 86_400_000}d ` +
        `(${rows.length} lines read, ${expired} expired)`,
    );
    // Rewrite once the log is mostly history rather than content — expired
    // rows and superseded duplicates both count as history.
    if (map.size > 0 && rows.length > map.size * 1.5) {
      await saveJsonl(FILE, [...map.values()]);
      linesOnDisk = map.size;
      console.log(`[seen] compacted ${rows.length} lines to ${map.size}`);
    }
  })();
  await loading;
  loading = null;
}

/** Call once before a run so the first lookup does not pay for the read. */
export async function primeSeen(): Promise<number> {
  await load();
  return store?.size ?? 0;
}

/**
 * What a previous run concluded about this account, if that conclusion is still
 * within its shelf life. Null means "never seen, or seen too long ago to trust".
 */
export function seenBefore(username: string): SeenRow | null {
  const row = store?.get(username.toLowerCase());
  if (!row) return null;
  if (!CACHED_BUCKETS.has(row.b)) return null;
  if (GOOD_BUCKETS.has(row.b)) return row; // good does not go stale
  if (Date.now() - row.t > TTL_MS) return null;
  return row;
}

/** Remember a verdict. Buckets with no shelf life are not recorded at all. */
export function recordSeen(username: string, bucket: string): void {
  if (!CACHED_BUCKETS.has(bucket)) return;
  const row: SeenRow = { u: username.toLowerCase(), b: bucket, t: Date.now() };
  store?.set(row.u, row);
  pending.push(row);
  schedule();
}

// Buffered exactly like the run logs: a fast run must not become one disk write
// per account.
const pending: SeenRow[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  if (pending.length >= 200) {
    void flushSeen();
    return;
  }
  if (!timer) timer = setTimeout(() => void flushSeen(), 3_000);
}

export async function flushSeen(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const rows = pending.splice(0, pending.length);
  if (!rows.length) return;
  linesOnDisk += rows.length;
  await appendLines(FILE, rows);
}

export function seenCount(): number {
  return store?.size ?? 0;
}
