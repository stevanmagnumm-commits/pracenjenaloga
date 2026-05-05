import { NextRequest, NextResponse } from "next/server";
import { fetchTikTokUserInfo, fetchTopVideos, TikTokVideo } from "@/lib/tiktok-api";

export interface TopVideosResult {
  username: string;
  nickname: string;
  followerCount: number;
  verified: boolean;
  videos: TikTokVideo[];
  error?: string;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { usernames, topN = 12, maxPages = 5 } = body as {
    usernames: string[];
    topN?: number;
    maxPages?: number;
  };

  if (!usernames || !Array.isArray(usernames) || usernames.length === 0) {
    return NextResponse.json({ error: "Provide at least one username" }, { status: 400 });
  }

  if (usernames.length > 20) {
    return NextResponse.json({ error: "Maximum 20 usernames at a time" }, { status: 400 });
  }

  const results: TopVideosResult[] = [];

  for (const raw of usernames) {
    const username = raw.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/, "").replace(/\/.*$/, "");
    if (!username) continue;

    try {
      const userInfo = await fetchTikTokUserInfo(username);
      const videos = await fetchTopVideos(userInfo.secUid, topN, maxPages);
      results.push({
        username: userInfo.uniqueId,
        nickname: userInfo.nickname,
        followerCount: userInfo.followerCount,
        verified: userInfo.verified,
        videos,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[tiktok:top-videos] Failed for ${username}:`, message);
      results.push({
        username,
        nickname: "",
        followerCount: 0,
        verified: false,
        videos: [],
        error: message,
      });
    }

    if (usernames.indexOf(raw) < usernames.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return NextResponse.json({ results });
}
