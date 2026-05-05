import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;
    const days = Number(req.nextUrl.searchParams.get("days") || "30");
    const since = days < 9999
      ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      : new Date(0);

    const snapshots = await prisma.threadsFollowerSnapshot.findMany({
      where: {
        accountId,
        snapshotAt: { gte: since },
      },
      orderBy: { snapshotAt: "asc" },
    });

    const dataPoints = snapshots.map((s) => ({
      date: s.snapshotAt.toISOString(),
      followers: s.followerCount,
    }));

    return NextResponse.json({ dataPoints });
  } catch (error) {
    console.error("Threads growth API error:", error);
    return NextResponse.json({ error: "Failed to fetch growth data" }, { status: 500 });
  }
}
