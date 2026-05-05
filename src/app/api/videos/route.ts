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
    const { searchParams } = req.nextUrl;
    const range = searchParams.get("range") || "all";
    const sort = searchParams.get("sort") || "views";
    const dir = searchParams.get("dir") || "desc";
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));

    const cutoff = getDateCutoff(range);
    const whereMedia = cutoff
      ? { publishedAt: { gte: cutoff } }
      : {};

    const total = await prisma.media.count({ where: whereMedia });

    const media = await prisma.media.findMany({
      where: whereMedia,
      include: {
        account: {
          select: { username: true },
        },
        snapshots: {
          orderBy: { snapshotAt: "desc" },
          take: 1,
        },
      },
    });

    const withMetrics = media.map((m) => {
      const snap = m.snapshots[0];
      return {
        id: m.id,
        shortcode: m.shortcode,
        caption: m.caption,
        thumbnailUrl: m.thumbnailUrl,
        mediaType: m.mediaType,
        duration: m.duration,
        publishedAt: m.publishedAt,
        username: m.account.username,
        viewCount: snap?.viewCount ?? 0,
        likeCount: snap?.likeCount ?? 0,
        commentCount: snap?.commentCount ?? 0,
        engagementRate: snap?.engagementRate ?? 0,
      };
    });

    withMetrics.sort((a, b) => {
      let valA: number;
      let valB: number;

      switch (sort) {
        case "views":
          valA = a.viewCount;
          valB = b.viewCount;
          break;
        case "likes":
          valA = a.likeCount;
          valB = b.likeCount;
          break;
        case "comments":
          valA = a.commentCount;
          valB = b.commentCount;
          break;
        case "er":
          valA = a.engagementRate;
          valB = b.engagementRate;
          break;
        case "date":
          valA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
          valB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
          break;
        case "duration":
          valA = a.duration ?? 0;
          valB = b.duration ?? 0;
          break;
        default:
          valA = a.viewCount;
          valB = b.viewCount;
      }

      return dir === "asc" ? valA - valB : valB - valA;
    });

    const offset = (page - 1) * limit;
    const paginated = withMetrics.slice(offset, offset + limit);

    return NextResponse.json({
      videos: paginated,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Videos API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch videos" },
      { status: 500 }
    );
  }
}
