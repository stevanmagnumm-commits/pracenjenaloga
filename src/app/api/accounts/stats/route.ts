import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sort = req.nextUrl.searchParams.get("sort") || "totalViews";
    const dir = req.nextUrl.searchParams.get("dir") || "desc";

    const groupId = req.nextUrl.searchParams.get("groupId");

    const whereClause = groupId
      ? { groups: { some: { groupId } } }
      : {};

    const accounts = await prisma.trackedAccount.findMany({
      where: whereClause,
      include: {
        snapshots: {
          orderBy: { snapshotAt: "desc" },
          take: 1,
        },
        media: {
          include: {
            snapshots: {
              orderBy: { snapshotAt: "desc" },
              take: 1,
            },
          },
        },
        groups: {
          include: { group: { select: { id: true, name: true } } },
        },
      },
    });

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const accountStats = accounts.map((account) => {
      let totalViews = 0;
      let totalLikes = 0;
      let totalComments = 0;
      let totalER = 0;
      let mediaWithSnaps = 0;
      let postsLastWeek = 0;

      for (const m of account.media) {
        const snap = m.snapshots[0];
        if (snap) {
          totalViews += snap.viewCount;
          totalLikes += snap.likeCount;
          totalComments += snap.commentCount;
          totalER += snap.engagementRate;
          mediaWithSnaps++;
        }
        if (m.publishedAt && m.publishedAt >= oneWeekAgo) {
          postsLastWeek++;
        }
      }

      const avgER = mediaWithSnaps > 0 ? totalER / mediaWithSnaps : 0;
      const avgVideoViews = mediaWithSnaps > 0 ? Math.round(totalViews / mediaWithSnaps) : 0;

      // Average views over the most recent 36 reels — matches the rolling
      // window that refreshAccount now updates each cycle. Sort by publishedAt
      // desc; fall back to igMediaId desc (which is monotonic with time) when
      // publishedAt is missing.
      const sortedByRecency = [...account.media].sort((a, b) => {
        const at = a.publishedAt?.getTime() ?? 0;
        const bt = b.publishedAt?.getTime() ?? 0;
        if (at !== bt) return bt - at;
        return b.igMediaId.localeCompare(a.igMediaId);
      });
      let last36Views = 0;
      let last36Count = 0;
      for (const m of sortedByRecency.slice(0, 36)) {
        const snap = m.snapshots[0];
        if (snap) {
          last36Views += snap.viewCount;
          last36Count++;
        }
      }
      const avgLast36Views = last36Count > 0 ? Math.round(last36Views / last36Count) : 0;

      // Most recent post date from tracked media
      const lastPosted = sortedByRecency[0]?.publishedAt ?? null;

      const latestSnap = account.snapshots[0];

      return {
        id: account.id,
        username: account.username,
        fullName: account.fullName,
        isVerified: account.isVerified,
        status: account.status ?? "active",
        note: account.note ?? null,
        // Pre-created during a bulk import but initialImport hasn't completed
        // yet — lastRefreshedAt is only set at the end of initialImport.
        importing: account.lastRefreshedAt === null,
        videosTracked: account.media.length,
        totalMediaCount: latestSnap?.mediaCount ?? 0,
        avgER,
        totalViews,
        totalLikes,
        totalComments,
        avgVideoViews,
        avgLast36Views,
        postsLastWeek,
        lastPosted,
        lastTracked: account.lastRefreshedAt,
        createdAt: account.createdAt,
        groups: account.groups.map((g) => ({ id: g.group.id, name: g.group.name })),
      };
    });

    accountStats.sort((a, b) => {
      // Always pin still-importing accounts to the top so the user can watch
      // them populate as initialImport completes in the background.
      if (a.importing !== b.importing) return a.importing ? -1 : 1;

      let valA: number;
      let valB: number;

      switch (sort) {
        case "totalViews":
          valA = a.totalViews;
          valB = b.totalViews;
          break;
        case "totalLikes":
          valA = a.totalLikes;
          valB = b.totalLikes;
          break;
        case "totalComments":
          valA = a.totalComments;
          valB = b.totalComments;
          break;
        case "avgER":
          valA = a.avgER;
          valB = b.avgER;
          break;
        case "videosTracked":
          valA = a.videosTracked;
          valB = b.videosTracked;
          break;
        case "avgVideoViews":
          valA = a.avgVideoViews;
          valB = b.avgVideoViews;
          break;
        case "avgLast36Views":
          valA = a.avgLast36Views;
          valB = b.avgLast36Views;
          break;
        case "postsLastWeek":
          valA = a.postsLastWeek;
          valB = b.postsLastWeek;
          break;
        case "lastTracked":
          valA = a.lastTracked ? new Date(a.lastTracked).getTime() : 0;
          valB = b.lastTracked ? new Date(b.lastTracked).getTime() : 0;
          break;
        case "lastPosted":
          valA = a.lastPosted ? new Date(a.lastPosted).getTime() : 0;
          valB = b.lastPosted ? new Date(b.lastPosted).getTime() : 0;
          break;
        default:
          valA = a.totalViews;
          valB = b.totalViews;
      }

      return dir === "asc" ? valA - valB : valB - valA;
    });

    return NextResponse.json(accountStats, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    console.error("Accounts stats API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch account stats" },
      { status: 500 }
    );
  }
}
