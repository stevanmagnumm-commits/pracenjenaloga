import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sort = req.nextUrl.searchParams.get("sort") || "followers";
    const dir = req.nextUrl.searchParams.get("dir") || "desc";

    const accounts = await prisma.threadsAccount.findMany({
      include: {
        snapshots: {
          orderBy: { snapshotAt: "desc" },
          take: 2,
        },
      },
    });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const accountStats = await Promise.all(
      accounts.map(async (account) => {
        const snap7d = await prisma.threadsFollowerSnapshot.findFirst({
          where: { accountId: account.id, snapshotAt: { lte: sevenDaysAgo } },
          orderBy: { snapshotAt: "desc" },
        });

        const snap30d = await prisma.threadsFollowerSnapshot.findFirst({
          where: { accountId: account.id, snapshotAt: { lte: thirtyDaysAgo } },
          orderBy: { snapshotAt: "desc" },
        });

        const current = account.followerCount;
        const growth7d = snap7d ? current - snap7d.followerCount : 0;
        const growth30d = snap30d ? current - snap30d.followerCount : 0;
        const growthPct7d = snap7d && snap7d.followerCount > 0
          ? ((current - snap7d.followerCount) / snap7d.followerCount) * 100
          : 0;
        const growthPct30d = snap30d && snap30d.followerCount > 0
          ? ((current - snap30d.followerCount) / snap30d.followerCount) * 100
          : 0;

        return {
          id: account.id,
          username: account.username,
          fullName: account.fullName,
          isVerified: account.isVerified,
          followers: current,
          growth7d,
          growth30d,
          growthPct7d: Math.round(growthPct7d * 100) / 100,
          growthPct30d: Math.round(growthPct30d * 100) / 100,
          lastTracked: account.lastRefreshedAt,
          createdAt: account.createdAt,
        };
      })
    );

    accountStats.sort((a, b) => {
      let valA: number;
      let valB: number;

      switch (sort) {
        case "followers":
          valA = a.followers;
          valB = b.followers;
          break;
        case "growth7d":
          valA = a.growth7d;
          valB = b.growth7d;
          break;
        case "growth30d":
          valA = a.growth30d;
          valB = b.growth30d;
          break;
        case "growthPct7d":
          valA = a.growthPct7d;
          valB = b.growthPct7d;
          break;
        case "growthPct30d":
          valA = a.growthPct30d;
          valB = b.growthPct30d;
          break;
        case "lastTracked":
          valA = a.lastTracked ? new Date(a.lastTracked).getTime() : 0;
          valB = b.lastTracked ? new Date(b.lastTracked).getTime() : 0;
          break;
        default:
          valA = a.followers;
          valB = b.followers;
      }

      return dir === "asc" ? valA - valB : valB - valA;
    });

    return NextResponse.json(accountStats);
  } catch (error) {
    console.error("Threads accounts stats API error:", error);
    return NextResponse.json({ error: "Failed to fetch stats" }, { status: 500 });
  }
}
