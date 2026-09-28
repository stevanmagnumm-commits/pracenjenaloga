import {
  fetchProfileRaw,
  fetchHighlights,
  fetchLastPostAt,
  isQuotaExhausted,
} from "./instagram-api";

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
    try {
      const hs = await fetchHighlights(username);
      out.highlightCount = hs.length;
      out.highlightTitles = hs.map((h) => h.title).filter(Boolean).slice(0, 12);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "could not look" is not "there are none" — the count stays null.
      out.note = "highlights unreadable: " + msg.slice(0, 80);
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
    await pool(cleaned, CONCURRENCY, alive, async (u) => {
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
