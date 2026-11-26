import { loadJson, saveJson } from "./run-state";

/**
 * The last reels seen for an account, shared between the tools that fetch them.
 *
 * Both the Views Checker and Trial vs Organic ask the same provider the same
 * question - "this account's recent reels, with their view counts" - and both
 * pay the same one call for it. Running the Views Checker over a list and then
 * pasting trial reels from those same accounts an hour later used to buy the
 * identical answer twice.
 *
 * So whoever fetches reels drops them here, and whoever needs them asks here
 * first. The Views Checker only ever writes; it is the one tool whose whole
 * job is to go and look, and reading a cached answer into a screen headed
 * "checked just now" would be a lie. Trial vs Organic reads and writes.
 *
 * What is NOT cached
 * ------------------
 * Only reels that are on the profile. A trial reel is not on the profile and
 * is read from the other provider entirely, so nothing here can answer for
 * one; the saving is on the baseline side, where it is worth having.
 *
 * Staleness is the caller's call, not this file's: `recallOrganic` takes the
 * age it is willing to accept. Nothing here decides that a day-old number is
 * fine, because for one screen it is and for another it is not.
 */

const FILE = "organic-window.json";

/**
 * How many reels are kept per account.
 *
 * Twelve, for a window of six: the reader has to be able to drop the reels it
 * pasted as trial ones and still have six left. Six would mean a cached hit
 * silently answering with five.
 */
const KEEP_PER_ACCOUNT = 12;

/** Entries older than this are dropped on the next save. A week, not a day:
 *  the file is tiny, and a reader asking for a looser age is free to. */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface OrganicReel {
  shortcode: string;
  views: number;
}

export interface OrganicSnapshot {
  reels: OrganicReel[];
  /** When this was fetched, in epoch ms. */
  at: number;
}

type Store = Record<string, OrganicSnapshot>;

let store: Store | null = null;
let loading: Promise<Store> | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<Store> {
  if (store) return store;
  // Shared as a promise rather than as a result: a views run calls this from
  // forty workers at once, and caching only the answer would have all forty
  // read the file before any of them finished.
  if (!loading) {
    loading = loadJson<Store>(FILE)
      .then((data) => {
        store = data && typeof data === "object" ? data : {};
        return store;
      })
      .catch(() => {
        store = {};
        return store;
      });
  }
  return loading;
}

/**
 * Written a moment after the last change rather than on every one.
 *
 * A views run over three hundred accounts writes three hundred times in a few
 * minutes; a whole-file rewrite per account would be most of what the disk is
 * asked to do. Losing the last couple of seconds of a cache on a crash costs
 * one API call later, so there is nothing here worth paying for with a
 * synchronous write.
 */
function scheduleSave(): void {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushOrganicCache();
  }, 2_000);
  // Node keeps the process alive for a pending timer; this one must not be a
  // reason not to exit.
  if (typeof saveTimer === "object" && saveTimer && "unref" in saveTimer) {
    (saveTimer as { unref: () => void }).unref();
  }
}

export async function flushOrganicCache(): Promise<void> {
  if (!dirty || !store) return;
  dirty = false;
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  const keep: Store = {};
  for (const [name, snap] of Object.entries(store)) {
    if (snap.at >= cutoff) keep[name] = snap;
  }
  store = keep;
  await saveJson(FILE, keep);
}

const key = (username: string) => username.trim().replace(/^@/, "").toLowerCase();

/**
 * Keep this account's reels, newest first.
 *
 * The caller passes them in the order it wants them kept - this file does not
 * sort, because the two callers derive "newest" differently (one from the
 * media id, one from the shortcode) and silently re-ordering their work here
 * would make the cached answer disagree with the uncached one.
 */
export async function rememberOrganic(
  username: string,
  reels: OrganicReel[],
): Promise<void> {
  if (!username || !reels.length) return;
  const s = await load();
  s[key(username)] = { reels: reels.slice(0, KEEP_PER_ACCOUNT), at: Date.now() };
  scheduleSave();
}

/**
 * This account's reels, if they were fetched recently enough for the caller.
 *
 * Returns null rather than something stale: a caller that wanted a looser age
 * would have asked for one, and handing back an answer older than requested is
 * how a cache turns into a wrong number nobody can explain.
 */
export async function recallOrganic(
  username: string,
  maxAgeMs: number,
): Promise<OrganicSnapshot | null> {
  if (!username) return null;
  const s = await load();
  const hit = s[key(username)];
  if (!hit || !Array.isArray(hit.reels) || !hit.reels.length) return null;
  if (Date.now() - hit.at > maxAgeMs) return null;
  return hit;
}

/** Test seam only. */
export function __resetOrganicCacheForTest(): void {
  store = {};
  loading = null;
  dirty = false;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}
