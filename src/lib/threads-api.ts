import { prisma } from "./db";
import { getMonthKey } from "./utils";

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY!;
const THREADS_HOST = process.env.THREADS_RAPIDAPI_HOST || "meta-threads-scraper-stable.p.rapidapi.com";
const BASE_URL = `https://${THREADS_HOST}`;

async function trackApiCall() {
  const month = getMonthKey();
  await prisma.apiUsage.upsert({
    where: { month },
    update: { callCount: { increment: 1 } },
    create: { month, callCount: 1 },
  });
}

async function threadsPost(endpoint: string, body: Record<string, string>, retries = 2): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await trackApiCall();
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": THREADS_HOST,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });
    if (response.ok) return response.json();
    if (response.status === 504 && attempt < retries) {
      console.log(`[threadsPost] 504 timeout on ${endpoint}, retry ${attempt + 1}/${retries}...`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const text = await response.text();
    throw new Error(`Threads API error ${response.status}: ${text}`);
  }
  throw new Error("Unreachable");
}

export interface ThreadsProfile {
  pk: string;
  username: string;
  fullName: string;
  bio: string;
  isVerified: boolean;
  followerCount: number;
}

export async function fetchThreadsProfile(username: string): Promise<ThreadsProfile> {
  const data = await threadsPost("/get_threads_user_data.php", {
    username_or_url: username,
  }) as Record<string, unknown>;

  if (data.error) {
    throw new Error(`Threads API: ${data.error}`);
  }

  if (!data.pk && !data.id && !data.username) {
    throw new Error(`Threads API returned unexpected data for ${username}`);
  }

  return {
    pk: String(data.pk || data.id || ""),
    username: (data.username as string) || username,
    fullName: (data.full_name as string) || "",
    bio: (data.biography as string) || "",
    isVerified: (data.is_verified as boolean) || false,
    followerCount: (data.follower_count as number) || 0,
  };
}
