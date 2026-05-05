import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const { accountId } = await params;
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") || "media";

  if (type === "account") {
    const snapshots = await prisma.accountSnapshot.findMany({
      where: { accountId },
      orderBy: { snapshotAt: "asc" },
    });

    const header = "date,followers,following,media_count\n";
    const rows = snapshots
      .map(
        (s) =>
          `${s.snapshotAt.toISOString()},${s.followerCount},${s.followingCount},${s.mediaCount}`
      )
      .join("\n");

    return new NextResponse(header + rows, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="account-${accountId}-snapshots.csv"`,
      },
    });
  }

  const media = await prisma.media.findMany({
    where: { accountId },
    include: {
      snapshots: {
        orderBy: { snapshotAt: "desc" },
        take: 1,
      },
    },
    orderBy: { publishedAt: "desc" },
  });

  const header =
    "shortcode,type,caption,duration_sec,published_at,views,likes,comments,engagement_rate,url\n";
  const rows = media
    .map((m) => {
      const s = m.snapshots[0];
      const caption = (m.caption || "").replace(/"/g, '""').replace(/\n/g, " ");
      return [
        m.shortcode,
        m.mediaType,
        `"${caption}"`,
        m.duration || 0,
        m.publishedAt?.toISOString() || "",
        s?.viewCount || 0,
        s?.likeCount || 0,
        s?.commentCount || 0,
        s?.engagementRate?.toFixed(4) || 0,
        m.shortcode ? `https://www.instagram.com/reel/${m.shortcode}/` : "",
      ].join(",");
    })
    .join("\n");

  return new NextResponse(header + rows, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="media-${accountId}.csv"`,
    },
  });
}
