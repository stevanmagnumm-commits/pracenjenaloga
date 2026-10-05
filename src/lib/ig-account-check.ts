import {
  fetchProfileRaw,
  fetchHighlights,
  fetchLastPostAt,
  isQuotaExhausted,
} from "./instagram-api";
import { runInLane, laneWorkers } from "./api-lanes";

/**
 * Three small questions about an account, each asked only when it is ticked.
 *
 * Separate because they cost separately — one call each — and because one
 * answer is often the only one wanted. All three over a 5,000-account list is
 * 15,000 calls; only "does it have highlights" is 5,000.
 *
 *   highlights   fetchHighlights         1 call
 *   posts        profile (media_count)   1 call
 *   last post    posts list (taken_at)   1 call
 */

export interface AccountCheckWants {
  highlights: boolean;
  posts: boolean;
  lastPost: boolean;
}

export interface AccountCheckResult {
  username: string;
  /** null when not asked for, or when the account could not be read. */
  highlightCount: number | null;
  highlightTitles: string[];
  postCount: number | null;
  lastPostAt: string | null;
  status: "ok" | "gone" | "private" | "failed";
  note?: string;
}

export interface AccountCheckProgress {
  total: number;
  completed: number;
  current: string | null;
  running: boolean;
  wants: AccountCheckWants;
  startedAt: number | null;
  finishedAt: number | null;
  abortedReason: string | null;
  results: AccountCheckResult[];
}

const CONCURRENCY = Math.max(1, Number(process.env.IG_ACCOUNT_CONCURRENCY) || 40);

/**
 * How many times an empty highlight list is asked for before it is believed.
 *
 * Three was not enough. @chlloerogers19 answers empty about one time in three,
 * so three tries still leaves a 4% chance of calling it none — and it did, on
 * the first run after the fix. Five brings that under half a percent.
 *
 * Only genuinely empty accounts pay the full five; an account with any
 * highlights breaks out on its first non-empty answer, usually the first call.
 */
const ZERO_CONFIRMATIONS = Math.max(1, Number(process.env.IG_HL_ZERO_TRIES) || 5);
const ZERO_RETRY_DELAY = Number(process.env.IG_HL_ZERO_DELAY ?? 1200);

function fresh(
  total: number,
  wants: AccountCheckWants,
  running: boolean,
): AccountCheckProgress {
  return {
    total,
    completed: 0,
    current: null,
    running,
    wants,
    startedAt: running ? Date.now() : null,
    finishedAt: null,
    abortedReason: null,
    results: [],
  };
}

let progress: AccountCheckProgress = fresh(
  0,
  { highlights: true, posts: false, lastPost: false },
  false,
);
let runToken = 0;
let quotaAbort: string | null = null;

export function getAccountCheckProgress(): AccountCheckProgress {
  return progress;
}

export function stopAccountCheck(): void {
  if (progress.running) {
    progress.running = false;
    progress.current = null;
    progress.finishedAt = Date.now();
    console.log("[ig-account-check] Stopped by user");
  }
}

async function inspect(
  username: string,
  wants: AccountCheckWants,
): Promise<AccountCheckResult> {
  const out: AccountCheckResult = {
    username,
    highlightCount: null,
    highlightTitles: [],
    postCount: null,
    lastPostAt: null,
    status: "ok",
  };

  // The profile is needed for the post count and for nothing else, so it is not
  // fetched when the post count was not asked for.
  if (wants.posts) {
    try {
      const p = await fetchProfileRaw(username);
      out.postCount = Number(p.media_count) || 0;
      if (p.is_private === true) out.status = "private";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|does not exist|invalid username/i.test(msg)) {
        return { ...out, status: "gone", note: "profile not found" };
      }
      return { ...out, status: "failed", note: msg.slice(0, 120) };
    }
  }

  if (wants.highlights) {
    // A zero needs confirming; a number does not.
    //
    // The endpoint answers with an empty list for accounts that plainly have
    // highlights, and it does it most on the accounts with the fewest. Probed
    // six times each: @ashleygarzaa19 returned 1,1,0,0,0,1 — it has one, and
    // half the answers said none. @chlloerogers19 gave 1,1,1,0,1,0. An account
    // with fourteen answered 14 every time.
    //
    // So only a zero pays for another look, and only zeros all the way down are
    // reported as none. An account that has any is usually right the first time
    // and costs one call, exactly as before.
    let hs: Awaited<ReturnType<typeof fetchHighlights>> = [];
    let read = false;
    let lastErr = "";
    for (let attempt = 0; attempt < ZERO_CONFIRMATIONS; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, ZERO_RETRY_DELAY));
      try {
        hs = await fetchHighlights(username);
        read = true;
        if (hs.length) break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    if (read) {
      out.highlightCount = hs.length;
      out.highlightTitles = hs.map((h) => h.title).filter(Boolean).slice(0, 12);
    } else {
      // "could not look" is not "there are none" — the count stays null.
      out.note = "highlights unreadable: " + lastErr.slice(0, 80);
    }
  }

  if (wants.lastPost) {
    try {
      const d = await fetchLastPostAt(username);
      out.lastPostAt = d ? d.toISOString() : null;
    } catch {
      out.note = (out.note ? out.note + "; " : "") + "last post unreadable";
    }
  }

  return out;
}

async function pool<T>(
  items: T[],
  limit: number,
  alive: () => boolean,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (alive()) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function runAccountCheck(
  usernames: string[],
  wants: AccountCheckWants,
): Promise<void> {
  return runInLane("account", () => accountRun(usernames, wants));
}

async function accountRun(
  usernames: string[],
  wants: AccountCheckWants,
): Promise<void> {
  if (progress.running) return;
  const cleaned = [
    ...new Set(
      usernames.map((u) => u.trim().replace(/^@/, "").toLowerCase()).filter(Boolean),
    ),
  ];
  if (!cleaned.length) return;

  const myToken = ++runToken;
  quotaAbort = null;
  const alive = () => progress.running && runToken === myToken && !quotaAbort;
  progress = fresh(cleaned.length, wants, true);

  console.log(
    "[ig-account-check] " +
      cleaned.length +
      " accounts; highlights=" +
      wants.highlights +
      " posts=" +
      wants.posts +
      " lastPost=" +
      wants.lastPost,
  );

  try {
    await pool(cleaned, laneWorkers("account", CONCURRENCY), alive, async (u) => {
      progress.current = u;
      try {
        const r = await inspect(u, wants);
        if (alive()) progress.results.push(r);
      } catch (err) {
        if (isQuotaExhausted(err) && !quotaAbort) {
          quotaAbort =
            "Monthly API quota exhausted — run stopped. Nothing will check until the plan resets.";
          console.error("[ig-account-check] ABORT: " + quotaAbort);
        }
        if (alive()) {
          progress.results.push({
            username: u,
            highlightCount: null,
            highlightTitles: [],
            postCount: null,
            lastPostAt: null,
            status: "failed",
            note: (err instanceof Error ? err.message : String(err)).slice(0, 120),
          });
        }
      }
      progress.completed++;
    });
  } catch (err) {
    console.error("[ig-account-check] Batch error:", err);
  } finally {
    if (runToken === myToken) {
      progress.current = null;
      progress.running = false;
      progress.finishedAt = Date.now();
      progress.abortedReason = quotaAbort;
      console.log("[ig-account-check] Done. " + progress.results.length + " checked");
    }
  }
}
