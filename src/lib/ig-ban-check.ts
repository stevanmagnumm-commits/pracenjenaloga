import { prisma } from "./db";
import { getMonthKey } from "./utils";

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY!;
const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST || "instagram-scraper-stable-api.p.rapidapi.com";
const BASE_URL = `https://${RAPIDAPI_HOST}`;
const RATE_DELAY = 1300;

async function trackApiCall() {
  const month = getMonthKey();
  await prisma.apiUsage.upsert({
    where: { month },
    update: { callCount: { increment: 1 } },
    create: { month, callCount: 1 },
  });
}

export interface IgBanCheckResult {
  username: string;
  status: "alive" | "banned";
}

async function checkProfile(username: string): Promise<IgBanCheckResult> {
  try {
    await trackApiCall();
    const response = await fetch(`${BASE_URL}/ig_get_fb_profile_v3.php`, {
      method: "POST",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ username_or_url: username }).toString(),
    });

    if (!response.ok) {
      console.log(`[ig-ban-check] @${username} → HTTP ${response.status} → BANNED`);
      return { username, status: "banned" };
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (!data.pk && !data.id && !data.username) {
      console.log(`[ig-ban-check] @${username} → empty response → BANNED`);
      return { username, status: "banned" };
    }

    console.log(`[ig-ban-check] @${username} → ALIVE`);
    return { username, status: "alive" };
  } catch (err) {
    console.error(`[ig-ban-check] @${username} → error:`, err);
    return { username, status: "banned" };
  }
}

export interface IgBanCheckProgress {
  total: number;
  completed: number;
  current: string | null;
  alive: number;
  banned: number;
  running: boolean;
  results: IgBanCheckResult[];
}

let progress: IgBanCheckProgress = {
  total: 0,
  completed: 0,
  current: null,
  alive: 0,
  banned: 0,
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
      else progress.banned++;

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
