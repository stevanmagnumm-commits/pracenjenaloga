import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function getDateCutoff(range: string): Date | null {
  const now = new Date();
  switch (range) {
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    default:
      return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    const range = req.nextUrl.searchParams.get("range") || "7d";
    const cutoff = getDateCutoff(range);

    const whereMedia = cutoff
      ? { publishedAt: { gte: cutoff } }
      : {};

    const media = await prisma.media.findMany({
      where: whereMedia,
      include: {
        snapshots: {
          orderBy: { snapshotAt: "desc" },
          take: 1,
        },
      },
    });

    let totalViews = 0;
    let totalLikes = 0;
    let totalComments = 0;

    for (const m of media) {
      const snap = m.snapshots[0];
      if (snap) {
        totalViews += snap.viewCount;
        totalLikes += snap.likeCount;
        totalComments += snap.commentCount;
      }
    }

    const totalEngagement = totalLikes + totalComments;

    const viewsOverTime: Record<string, number> = {};
    for (const m of media) {
      if (!m.publishedAt) continue;
      const dateKey = m.publishedAt.toISOString().split("T")[0];
      const snap = m.snapshots[0];
      if (snap) {
        viewsOverTime[dateKey] = (viewsOverTime[dateKey] || 0) + snap.viewCount;
      }
    }

    const sortedDates = Object.keys(viewsOverTime).sort();
    const viewsChart = sortedDates.map((date) => ({
      date,
      views: viewsOverTime[date],
    }));

    const topVideos = media
      .filter((m) => m.snapshots.length > 0)
      .sort((a, b) => (b.snapshots[0]?.viewCount ?? 0) - (a.snapshots[0]?.viewCount ?? 0))
      .slice(0, 5);

    const topVideoIds = topVideos.map((v) => v.accountId);
    const accounts = await prisma.trackedAccount.findMany({
      where: { id: { in: topVideoIds } },
      select: { id: true, username: true },
    });
    const accountMap = new Map(accounts.map((a) => [a.id, a.username]));

    const topVideoData = topVideos.map((v) => {
      const snap = v.snapshots[0];
      return {
        id: v.id,
        shortcode: v.shortcode,
        caption: v.caption,
        thumbnailUrl: v.thumbnailUrl,
        publishedAt: v.publishedAt,
        username: accountMap.get(v.accountId) || "unknown",
        viewCount: snap?.viewCount ?? 0,
        likeCount: snap?.likeCount ?? 0,
        commentCount: snap?.commentCount ?? 0,
        engagementRate: snap?.engagementRate ?? 0,
      };
    });

    const totalAccounts = await prisma.trackedAccount.count();
    const trackedMedia = media.length;

    const accountSnaps = await prisma.accountSnapshot.findMany({
      distinct: ["accountId"],
      orderBy: { snapshotAt: "desc" },
      select: { mediaCount: true },
    });
    const totalMediaFromAPI = accountSnaps.reduce((sum, s) => sum + s.mediaCount, 0);

    return NextResponse.json({
      totalViews,
      totalLikes,
      totalComments,
      totalEngagement,
      totalAccounts,
      trackedMedia,
      totalMediaFromAPI,
      viewsChart,
      topVideos: topVideoData,
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    console.error("Overview API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch overview data" },
      { status: 500 }
    );
  }
}
