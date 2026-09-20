import { fetchProfile } from "./instagram-api";
import {
  saveJson,
  loadJson,
  readLines,
  removeFiles,
  ResultLog,
} from "./run-state";

/** So a restart cannot take the list of accounts still to check with it. */
const WORK_FILE = "ban-check-work.json";
const RESULTS_FILE = "ban-check-results.jsonl";

interface SavedBanWork {
  usernames: string[];
  startedAt: number;
}

export interface ResumableBanCheck {
  total: number;
  done: number;
  remaining: number;
}

const IG_PROVIDER = (process.env.IG_PROVIDER || "stable").toLowerCase();

// The mediacrawlers provider has a strict per-second rate limit. Under heavy
// batch load it not only returns 429 (handled as "inconclusive"/retried) but can
// also emit a RARE false 404 ("not found") for an account that is actually alive.
// A single recheck can hit that false 404 twice in a row and mislabel a live
// account as banned. To stay accurate we (a) pace requests a bit slower to reduce
// the 429/false-404 pressure, and (b) require an EXTRA confirming probe before
// declaring a ban. The stable provider (main tracker) keeps its original,
// proven-good timings and two-probe confirmation — untouched.

// How many accounts are checked side by side.
//
// This used to be one, and the 1.3s pause below was the only thing keeping the
// app under the plan's 50 calls/minute. Both were standing in for a rate limit
// that was not enforced anywhere. It is enforced now, in rate-limit.ts, on
// every call the app makes — so the pool can be sized for throughput and the
// ceiling is still never crossed.
const CONCURRENCY = Math.max(1, Number(process.env.IG_BAN_CONCURRENCY) || 20);

// Delay between consecutive accounts on the same worker. Zero by default now
// that the limiter paces calls globally; kept as a knob because it is the
// quickest way to back the tool off if the provider ever needs it.
const RATE_DELAY = Number(
  process.env.IG_BAN_RATE_DELAY ?? (IG_PROVIDER === "mediacrawlers" ? 1200 : 0),
);
// Wait between confirming probes when a "missing" is seen, so transient
// rate-limit pressure can subside before we trust the signal.
const RECHECK_DELAY = IG_PROVIDER === "mediacrawlers" ? 4000 : 8000;
// How many consecutive "missing" probes are required to declare a ban.
// mediacrawlers → 3 (defends against its rare false 404 under load).
// stable        → 2 (unchanged, original behavior).
const BAN_CONFIRMATIONS = IG_PROVIDER === "mediacrawlers" ? 3 : 2;

export type IgBanStatus = "alive" | "banned" | "inconclusive";

export interface IgBanCheckResult {
  username: string;
  status: IgBanStatus;
}

// Single profile probe. Distinguishes a real "account is gone" signal from a
// transient API hiccup so the latter never gets misread as a ban.
//   - alive        → profile fetched successfully
//   - missing      → API explicitly says the profile/data was not found
//   - inconclusive → network error, rate limit, 5xx, parse error, etc.
async function probeProfileMissing(
  username: string,
): Promise<"missing" | "alive" | "inconclusive"> {
  try {
    await fetchProfile(username);
    return "alive";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Profile not found") || msg.includes("data not found")) {
      return "missing";
    }
    return "inconclusive";
  }
}

// Only declare a ban after BAN_CONFIRMATIONS consecutive "missing" responses,
// spaced by RECHECK_DELAY. As soon as ANY probe says "alive" the account is
// alive; any transient failure resolves to "inconclusive" (status unknown)
// instead of a false "banned".
async function checkProfile(username: string): Promise<IgBanCheckResult> {
  for (let probe = 0; probe < BAN_CONFIRMATIONS; probe++) {
    if (probe > 0) {
      await new Promise((r) => setTimeout(r, RECHECK_DELAY));
    }
    const result = await probeProfileMissing(username);

    if (result === "alive") {
      const note = probe === 0 ? "" : " (recovered on recheck)";
      console.log(`[ig-ban-check] @${username} → ALIVE${note}`);
      return { username, status: "alive" };
    }
    if (result === "inconclusive") {
      const note = probe === 0 ? "(transient)" : "(recheck transient)";
      console.log(`[ig-ban-check] @${username} → INCONCLUSIVE ${note}`);
      return { username, status: "inconclusive" };
    }
    // result === "missing" → keep probing until we reach BAN_CONFIRMATIONS.
  }

  console.log(`[ig-ban-check] @${username} → BANNED (confirmed ${BAN_CONFIRMATIONS}x)`);
  return { username, status: "banned" };
}

export interface IgBanCheckProgress {
  total: number;
  completed: number;
  current: string | null;
  alive: number;
  banned: number;
  inconclusive: number;
  running: boolean;
  results: IgBanCheckResult[];
}

let progress: IgBanCheckProgress = {
  total: 0,
  completed: 0,
  current: null,
  alive: 0,
  banned: 0,
  inconclusive: 0,
  running: false,
  results: [],
};

export function getIgBanCheckProgress(): IgBanCheckProgress {
  return progress;
}

export function stopIgBanCheck(): void {
  if (progress.running) {
    progress.running = false;
    progress.current = null;
    console.log("[ig-ban-check] Stopped by user");
  }
}

export async function runIgBanCheck(usernames: string[]): Promise<void> {
  if (progress.running) return;

  const cleaned = [
    ...new Set(
      usernames
        .map((u) => u.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean),
    ),
  ];

  progress = {
    total: cleaned.length,
    completed: 0,
    current: null,
    alive: 0,
    banned: 0,
    inconclusive: 0,
    running: true,
    results: [],
  };

  await removeFiles(WORK_FILE, RESULTS_FILE);
  await saveJson(WORK_FILE, {
    usernames: cleaned,
    startedAt: Date.now(),
  } satisfies SavedBanWork);

  await runBatch(cleaned);
}

/** The loop itself, shared by a fresh run and a resumed one. */
async function runBatch(cleaned: string[]): Promise<void> {
  const log = new ResultLog<IgBanCheckResult>(RESULTS_FILE);

  try {
    // Accounts run side by side; each account's own protocol is untouched.
    //
    // The distinction matters, because the old sequential walk is the reason
    // this checker is trusted. What made parallel probing dangerous was never
    // parallelism as such — it was going over the per-minute cap, which makes
    // the provider answer "data not found" for accounts that are alive. That
    // cap is now enforced in rate-limit.ts for every call the app makes, so a
    // worker that would overshoot waits there instead of provoking a bad
    // answer, and the two probes behind a ban stay as independent as they were
    // when the sequential version was measured correct.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, cleaned.length) }, async () => {
        for (;;) {
          if (!progress.running) return;
          const i = next++;
          if (i >= cleaned.length) return;

          const username = cleaned[i];
          progress.current = username;

          const result = await checkProfile(username);
          progress.results.push(result);
          log.add(result);

          if (result.status === "alive") progress.alive++;
          else if (result.status === "banned") progress.banned++;
          else progress.inconclusive++;

          progress.completed++;

          if (RATE_DELAY > 0 && progress.running) {
            await new Promise((r) => setTimeout(r, RATE_DELAY));
          }
        }
      }),
    );
  } catch (err) {
    console.error("[ig-ban-check] Batch error:", err);
  } finally {
    await log.flush();
    progress.current = null;
    progress.running = false;
    // A finished list gives up its state file; a stopped or crashed one keeps
    // it, which is the whole point of writing it down.
    if (progress.completed >= progress.total) {
      await removeFiles(WORK_FILE, RESULTS_FILE);
    }
  }
}

/** What an interrupted ban check left behind, if anything. */
export async function getResumableBanCheck(): Promise<ResumableBanCheck | null> {
  if (progress.running) return null;
  const saved = await loadJson<SavedBanWork>(WORK_FILE);
  if (!saved?.usernames?.length) return null;
  const done = await readLines<IgBanCheckResult>(RESULTS_FILE);
  const remaining = saved.usernames.length - done.length;
  if (remaining <= 0) return null;
  return { total: saved.usernames.length, done: done.length, remaining };
}

/** Continue where a restart cut the list off, without re-checking anyone. */
export async function resumeIgBanCheck(): Promise<boolean> {
  if (progress.running) return false;

  const saved = await loadJson<SavedBanWork>(WORK_FILE);
  if (!saved?.usernames?.length) return false;

  const done = await readLines<IgBanCheckResult>(RESULTS_FILE);
  const answered = new Set(done.map((r) => r.username.toLowerCase()));
  const remaining = saved.usernames.filter((u) => !answered.has(u.toLowerCase()));

  if (!remaining.length) {
    await removeFiles(WORK_FILE, RESULTS_FILE);
    return false;
  }

  progress = {
    total: saved.usernames.length,
    completed: done.length,
    current: null,
    alive: done.filter((r) => r.status === "alive").length,
    banned: done.filter((r) => r.status === "banned").length,
    inconclusive: done.filter((r) => r.status === "inconclusive").length,
    running: true,
    results: [...done],
  };

  console.log(
    `[ig-ban-check] Resuming: ${done.length} already answered, ${remaining.length} to go`,
  );
  void runBatch(remaining);
  return true;
}
