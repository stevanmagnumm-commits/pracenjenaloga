/**
 * One budget for every call the app makes to the scraping API.
 *
 * Every request in instagram-api.ts — apiGet, apiPost, mcGet, and so all three
 * checkers — passes through a single fetch helper, so one gate there is the
 * whole application's ceiling. That matters more than it sounds. The plan's
 * per-minute cap was never enforced in code, only approximated by keeping
 * worker pools small, and that approximation caused the two worst bugs this
 * project has had. Going over the cap does not fail loudly: the provider
 * answers HTTP 200 with {"message":"You have exceeded the rate limit..."},
 * which was read as "this account has no reels" (239 false "No data" rows on
 * one run), and under the same pressure answers "data not found" for accounts
 * that are alive, which was read as banned (59 of 113 wrong).
 *
 * With a real limiter the cap is a fact instead of a hope, and that is what
 * makes it safe to raise the worker pools: a worker that would overshoot waits
 * here rather than provoking an answer we cannot trust.
 *
 * Sliding window rather than a token bucket on purpose — the provider counts
 * calls per rolling minute, so the limiter should measure the same thing it is
 * trying not to exceed.
 */

const DEFAULT_LIMIT = 280;

let limit = Math.max(1, Number(process.env.IG_API_RATE_PER_MIN) || DEFAULT_LIMIT);

/** Issue times of calls made within the window, oldest first. */
let window: number[] = [];

/**
 * Slots are handed out strictly one at a time. Without this, N concurrent
 * workers all read "there is room" in the same tick and fire together — the
 * exact burst the limiter exists to prevent.
 */
let gate: Promise<void> = Promise.resolve();

const WINDOW_MS = 60_000;

function trim(now: number): void {
  while (window.length && now - window[0] >= WINDOW_MS) window.shift();
}

/** Issue time of the most recent call, for the even-spacing rule below. */
let lastIssue = 0;

/** Blocks until this call is within budget, then records it. */
export function acquireApiSlot(): Promise<void> {
  const mine = gate.then(async () => {
    for (;;) {
      const now = Date.now();
      trim(now);

      if (window.length >= limit) {
        // Full — wait exactly until the oldest call falls out of the window.
        await new Promise((r) => setTimeout(r, WINDOW_MS - (now - window[0]) + 5));
        continue;
      }

      // Even spacing, and not a nicety: the window alone lets forty workers
      // spend the whole minute's budget in one burst, after which every one of
      // them blocks until the oldest call ages out. That is up to a full minute
      // in which the app does nothing at all, and watching it, it reads as a
      // freeze rather than as pacing. Holding one call per (minute / limit)
      // spends the same budget at the same ceiling without ever stopping.
      const wait = lastIssue + WINDOW_MS / limit - now;
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      lastIssue = now;
      window.push(now);
      return;
    }
  });
  gate = mine.catch(() => {});
  return mine;
}

/** Calls issued in the last minute, and the ceiling. For the UI and for tests. */
export function getApiRateUsage(): { used: number; limit: number } {
  trim(Date.now());
  return { used: window.length, limit };
}

/** Test seam only — production sets the limit from the environment at import. */
export function __setApiRateLimitForTest(next: number): void {
  limit = Math.max(1, next);
  window = [];
  lastIssue = 0;
  gate = Promise.resolve();
}
