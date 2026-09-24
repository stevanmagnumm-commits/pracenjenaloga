import { appendLines, readLines, saveJsonl } from "./run-state";

/**
 * Seeds that have already been asked for suggestions, and when.
 *
 * A seed's "similar accounts" list barely moves from day to day, so asking the
 * same one again buys almost nothing and costs a call every time. Measured on
 * seeds that were the most productive in an early run: they still return 78-80
 * suggestions today, but 89% of those are accounts already in the registry, and
 * one of them returned 79 suggestions of which zero were new. Across the last
 * run, 3,898 of 4,761 seeds produced no new good account at all.
 *
 * So a seed is put aside for ten days after it is used, and then comes back on
 * its own — long enough for the list to have moved, short enough that nothing
 * is lost for good. This is separate from seen-accounts.ts, which is about the
 * accounts a run finds; this is about the accounts a run asks.
 */

const DAY = 86_400_000;
const TTL_MS = Math.max(1, Number(process.env.IG_SEED_TTL_DAYS) || 10) * DAY;
const FILE = "seed-history.jsonl";

interface SeedRow {
  /** seed username, lowercased */
  s: string;
  /** epoch ms of the last time it was asked */
  t: number;
}

let store: Map<string, number> | null = null;
let loading: Promise<void> | null = null;

async function load(): Promise<void> {
  if (store) return;
  if (loading) return loading;
  loading = (async () => {
    const rows = await readLines<SeedRow>(FILE);
    const cutoff = Date.now() - TTL_MS;
    const map = new Map<string, number>();
    let expired = 0;
    for (const r of rows) {
      if (!r || typeof r.s !== "string") continue;
      // Dropped on the way in rather than ignored on lookup, so the file stays
      // the size of ten days of work instead of growing without end.
      if (!(r.t > cutoff)) {
        expired++;
        map.delete(r.s);
        continue;
      }
      map.set(r.s, r.t);
    }
    store = map;
    console.log(
      `[seed-history] ${map.size} seeds asked within ${TTL_MS / DAY}d ` +
        `(${rows.length} lines read, ${expired} expired)`,
    );
    if (map.size > 0 && rows.length > map.size * 1.5) {
      await saveJsonl(FILE, [...map.entries()].map(([s, t]) => ({ s, t })));
      console.log(`[seed-history] compacted ${rows.length} lines to ${map.size}`);
    }
  })();
  await loading;
  loading = null;
}

/** Call once before a run so the first lookup does not pay for the read. */
export async function primeSeedHistory(): Promise<number> {
  await load();
  return store?.size ?? 0;
}

/** When this seed was last asked, if that was recently enough to skip it. */
export function seedAskedRecently(seed: string): number | null {
  const t = store?.get(seed.toLowerCase());
  if (t === undefined) return null;
  if (Date.now() - t > TTL_MS) return null;
  return t;
}

export function recordSeedUse(seed: string): void {
  const s = seed.toLowerCase();
  const t = Date.now();
  store?.set(s, t);
  pending.push({ s, t });
  schedule();
}

const pending: SeedRow[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  if (pending.length >= 200) {
    void flushSeedHistory();
    return;
  }
  if (!timer) timer = setTimeout(() => void flushSeedHistory(), 3_000);
}

export async function flushSeedHistory(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const rows = pending.splice(0, pending.length);
  if (!rows.length) return;
  await appendLines(FILE, rows);
}

export function seedHistorySize(): number {
  return store?.size ?? 0;
}

/** Days a seed is set aside for — shown in the UI so the number is not a mystery. */
export const SEED_TTL_DAYS = TTL_MS / DAY;
