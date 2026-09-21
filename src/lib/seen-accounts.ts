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
 * Not everything keeps, though. A verdict is cached for as long as it is likely
 * to still be true, which is very different per bucket — an account written in
 * Cyrillic will not be writing in Latin next month, while one with an empty bio
 * may well have added a link.
 */

const DAY = 86_400_000;
const FOREVER = Number.POSITIVE_INFINITY;

const TTL_MS: Record<string, number> = {
  // Already qualified — we have the account, there is nothing left to learn.
  bio: FOREVER,
  signal: FOREVER,
  hlname: FOREVER,
  story: FOREVER,
  // The script an account writes in does not change.
  wrongscript: FOREVER,
  // Follower counts drift, but not from 9k to 10k in a week.
  outofrange: 30 * DAY,
  // The one that can genuinely turn good later: a link added to an empty bio.
  none: 30 * DAY,
  // A private account may open up.
  private: 14 * DAY,
};
// "failed" is absent on purpose: it is not an answer, so it is never cached.

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
    const map = new Map<string, SeenRow>();
    // Append-only, so a later line supersedes an earlier one for the same user.
    for (const r of rows) {
      if (r && typeof r.u === "string") map.set(r.u, r);
    }
    linesOnDisk = rows.length;
    store = map;
    console.log(`[seen] ${map.size} accounts known (${rows.length} lines)`);
    // Duplicates accumulate as accounts are re-recorded; rewrite once the log
    // is mostly history rather than content.
    if (rows.length > map.size * 2 && map.size > 0) {
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
  const ttl = TTL_MS[row.b];
  if (ttl === undefined) return null; // never cached (failed), or an old bucket name
  if (ttl !== FOREVER && Date.now() - row.t > ttl) return null;
  return row;
}

/** Remember a verdict. Buckets with no shelf life are not recorded at all. */
export function recordSeen(username: string, bucket: string): void {
  if (TTL_MS[bucket] === undefined) return;
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
