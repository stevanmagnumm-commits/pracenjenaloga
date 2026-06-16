import { fetchProfile } from "./instagram-api";

// Delay between consecutive accounts (the profile endpoint itself already
// retries/backs off on 429/5xx via apiPost).
const RATE_DELAY = 1300;
// When the first probe says "missing" we wait this long before re-checking,
// to avoid burst-induced false positives — same approach as the All Accounts
// "Check bans" action (see src/lib/refresh.ts).
const RECHECK_DELAY = 8000;

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

// Mirrors checkAccountBan in refresh.ts: only declare a ban after TWO separate
// "missing" responses with a delay between them. Any transient failure resolves
// to "inconclusive" (status unknown) instead of a false "banned".
async function checkProfile(username: string): Promise<IgBanCheckResult> {
  const first = await probeProfileMissing(username);

  if (first === "alive") {
    console.log(`[ig-ban-check] @${username} → ALIVE`);
    return { username, status: "alive" };
  }
  if (first === "inconclusive") {
    console.log(`[ig-ban-check] @${username} → INCONCLUSIVE (transient)`);
    return { username, status: "inconclusive" };
  }

  // First probe says missing — re-check after a delay before committing to a ban.
  await new Promise((r) => setTimeout(r, RECHECK_DELAY));
  const second = await probeProfileMissing(username);

  if (second === "missing") {
    console.log(`[ig-ban-check] @${username} → BANNED (confirmed twice)`);
    return { username, status: "banned" };
  }
  if (second === "alive") {
    console.log(`[ig-ban-check] @${username} → ALIVE (recovered on recheck)`);
    return { username, status: "alive" };
  }
  console.log(`[ig-ban-check] @${username} → INCONCLUSIVE (recheck transient)`);
  return { username, status: "inconclusive" };
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
