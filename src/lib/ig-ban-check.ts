import { fetchProfile } from "./instagram-api";

const IG_PROVIDER = (process.env.IG_PROVIDER || "stable").toLowerCase();

// The mediacrawlers provider has a strict per-second rate limit. Under heavy
// batch load it not only returns 429 (handled as "inconclusive"/retried) but can
// also emit a RARE false 404 ("not found") for an account that is actually alive.
// A single recheck can hit that false 404 twice in a row and mislabel a live
// account as banned. To stay accurate we (a) pace requests a bit slower to reduce
// the 429/false-404 pressure, and (b) require an EXTRA confirming probe before
// declaring a ban. The stable provider (main tracker) keeps its original,
// proven-good timings and two-probe confirmation — untouched.

// Delay between consecutive accounts (the profile endpoint itself already
// retries/backs off on 429/5xx).
const RATE_DELAY = IG_PROVIDER === "mediacrawlers" ? 1200 : 1300;
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

  try {
    for (let i = 0; i < cleaned.length; i++) {
      if (!progress.running) break;

      const username = cleaned[i];
      progress.current = username;

      const result = await checkProfile(username);
      progress.results.push(result);

      if (result.status === "alive") progress.alive++;
      else if (result.status === "banned") progress.banned++;
      else progress.inconclusive++;

      progress.completed = i + 1;

      if (i < cleaned.length - 1 && progress.running) {
        await new Promise((r) => setTimeout(r, RATE_DELAY));
      }
    }
  } catch (err) {
    console.error("[ig-ban-check] Batch error:", err);
  } finally {
    progress.current = null;
    progress.running = false;
  }
}
