import { prisma } from "./db";
import { getMonthKey } from "./utils";

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY!;
const TIKTOK_HOST = process.env.TIKTOK_RAPIDAPI_HOST || "tiktok-api23.p.rapidapi.com";
const BASE_URL = `https://${TIKTOK_HOST}`;
const RATE_DELAY = 1300;
const RETRY_DELAY = 1000;

async function trackApiCall() {
  const month = getMonthKey();
  await prisma.apiUsage.upsert({
    where: { month },
    update: { callCount: { increment: 1 } },
    create: { month, callCount: 1 },
  });
}

/**
 * GET against the TikTok provider, retrying the failures that are just noise.
 *
 * About 5% of calls come back 204 with an empty body for perfectly valid input —
 * the same random flakiness the download endpoint shows. That is harmless on its
 * own, but a single top-videos lookup makes up to 6 calls, so without retries
 * roughly a quarter of usernames used to fail outright. The monthly quota is
 * 200k, so retrying costs nothing worth worrying about.
 */
async function tiktokGet(endpoint: string, params: Record<string, string>, retries = 4): Promise<unknown> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  let lastIssue = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`[tiktokGet] ${lastIssue} on ${endpoint}, retry ${attempt}/${retries}...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY));
    }

    await trackApiCall();

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "x-rapidapi-key": RAPIDAPI_KEY,
          "x-rapidapi-host": TIKTOK_HOST,
          "Content-Type": "application/json",
        },
      });
    } catch {
      lastIssue = "network error";
      continue;
    }

    if (response.ok) {
      const text = await response.text();
      if (text.trim()) return JSON.parse(text);
      // 204 / empty body → provider hiccup, not an answer about the user.
      lastIssue = `empty ${response.status} body`;
      continue;
    }

    if (response.status === 504) {
      lastIssue = "504 timeout";
      continue;
    }

    const text = await response.text();
    throw new Error(`TikTok API error ${response.status}: ${text}`);
  }

  throw new Error(`TikTok API kept returning ${lastIssue} after ${retries} retries`);
}

export interface TikTokUserInfo {
  secUid: string;
  uniqueId: string;
  nickname: string;
  signature: string;
  verified: boolean;
  followerCount: number;
  videoCount: number;
  heartCount: number;
}

export async function fetchTikTokUserInfo(username: string): Promise<TikTokUserInfo> {
  const data = (await tiktokGet("/api/user/info", { uniqueId: username })) as {
    userInfo?: {
      user?: Record<string, unknown>;
      stats?: Record<string, unknown>;
    };
    statusCode?: number;
  };

  const statusCode = data.statusCode;
  if (statusCode && statusCode !== 0) {
    throw new Error(`TikTok user "${username}" not found (code: ${statusCode})`);
  }

  if (!data.userInfo?.user || !(data.userInfo.user as Record<string, unknown>).secUid) {
    throw new Error(`TikTok user "${username}" not found`);
  }

  const user = data.userInfo.user;
  const stats = data.userInfo.stats || {};

  return {
    secUid: (user.secUid as string) || "",
    uniqueId: (user.uniqueId as string) || username,
    nickname: (user.nickname as string) || "",
    signature: (user.signature as string) || "",
    verified: (user.verified as boolean) || false,
    followerCount: (stats.followerCount as number) || 0,
    videoCount: (stats.videoCount as number) || 0,
    heartCount: (stats.heartCount as number) || 0,
  };
}

export interface TikTokVideo {
  id: string;
  desc: string;
  createTime: number;
  duration: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  author: string;
  authorNickname: string;
  coverUrl: string;
}

interface RawTikTokPost {
  id: string;
  desc?: string;
  createTime: number;
  video?: { duration?: number; cover?: string };
  stats?: {
    playCount?: number;
    diggCount?: number;
    commentCount?: number;
    shareCount?: number;
    collectCount?: number;
  };
  author?: { uniqueId?: string; nickname?: string };
}

function normalizeVideo(item: RawTikTokPost): TikTokVideo {
  return {
    id: item.id,
    desc: item.desc || "",
    createTime: item.createTime,
    duration: item.video?.duration || 0,
    views: item.stats?.playCount || 0,
    likes: item.stats?.diggCount || 0,
    comments: item.stats?.commentCount || 0,
    shares: item.stats?.shareCount || 0,
    saves: item.stats?.collectCount || 0,
    author: item.author?.uniqueId || "",
    authorNickname: item.author?.nickname || "",
    coverUrl: item.video?.cover || "",
  };
}

export async function fetchTopVideos(
  secUid: string,
  topN: number = 12,
  maxPages: number = 5,
): Promise<TikTokVideo[]> {
  const allVideos: TikTokVideo[] = [];
  let cursor = "0";

  for (let page = 0; page < maxPages; page++) {
    const data = (await tiktokGet("/api/user/posts", {
      secUid,
      count: "35",
      cursor,
    })) as {
      data?: {
        itemList?: RawTikTokPost[];
        hasMore?: boolean;
        cursor?: string;
      };
    };

    const items = data.data?.itemList || [];
    for (const item of items) {
      allVideos.push(normalizeVideo(item));
    }

    if (!data.data?.hasMore || !data.data?.cursor) break;
    cursor = data.data.cursor;

    if (page < maxPages - 1) {
      await new Promise((r) => setTimeout(r, RATE_DELAY));
    }
  }

  allVideos.sort((a, b) => b.views - a.views);
  return allVideos.slice(0, topN);
}
