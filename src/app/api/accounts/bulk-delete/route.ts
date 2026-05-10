import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ids } = body as { ids: string[] };

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "Provide ids[] in body" }, { status: 400 });
    }

    const accounts = await prisma.trackedAccount.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true },
    });
    const usernames = accounts.map((a) => a.username);
    const foundIds = accounts.map((a) => a.id);

    // Wrap everything in a single transaction so we don't half-delete
    // accounts and leave dangling rows or scheduler ghosts.
    await prisma.$transaction(
      [
        prisma.mediaSnapshot.deleteMany({
          where: { media: { accountId: { in: foundIds } } },
        }),
        prisma.media.deleteMany({ where: { accountId: { in: foundIds } } }),
        prisma.accountSnapshot.deleteMany({ where: { accountId: { in: foundIds } } }),
        prisma.accountGroupMember.deleteMany({ where: { accountId: { in: foundIds } } }),
        prisma.trackedAccount.deleteMany({ where: { id: { in: foundIds } } }),
        prisma.scheduleEntry.deleteMany({ where: { username: { in: usernames } } }),
      ],
      { timeout: 60000 }
    );

    return NextResponse.json({
      success: true,
      deleted: foundIds.length,
      requested: ids.length,
      missing: ids.length - foundIds.length,
    });
  } catch (error) {
    console.error("Bulk delete error:", error);
    return NextResponse.json(
      { error: "Failed to bulk delete", message: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
