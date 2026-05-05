import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const accounts = await prisma.threadsAccount.findMany();
    const totalAccounts = accounts.length;
    const totalFollowers = accounts.reduce((sum, a) => sum + a.followerCount, 0);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    let totalGrowth30d = 0;
    for (const account of accounts) {
      const oldSnap = await prisma.threadsFollowerSnapshot.findFirst({
        where: { accountId: account.id, snapshotAt: { lte: thirtyDaysAgo } },
        orderBy: { snapshotAt: "desc" },
      });
      if (oldSnap) {
        totalGrowth30d += account.followerCount - oldSnap.followerCount;
      }
    }

    const avgFollowers = totalAccounts > 0 ? Math.round(totalFollowers / totalAccounts) : 0;

    return NextResponse.json({
      totalAccounts,
      totalFollowers,
      avgFollowers,
      totalGrowth30d,
    });
  } catch (error) {
    console.error("Threads overview API error:", error);
    return NextResponse.json({ error: "Failed to fetch overview" }, { status: 500 });
  }
}
