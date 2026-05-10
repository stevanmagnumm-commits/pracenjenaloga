import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const CATEGORY_THRESHOLDS = [
  { min: 800, category: "ODLIČAN" },
  { min: 200, category: "DOBAR" },
  { min: 50, category: "LOŠI" },
  { min: 0, category: "SHADOWBANNED" },
];

function categoryFor(avgLast36Views: number): string {
  for (const t of CATEGORY_THRESHOLDS) {
    if (avgLast36Views >= t.min) return t.category;
  }
  return "SHADOWBANNED";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { groupIds, includeUngrouped, skipExisting = true } = body as {
      groupIds?: string[];
      includeUngrouped?: boolean;
      skipExisting?: boolean;
    };

    if (!groupIds && !includeUngrouped) {
      return NextResponse.json(
        { error: "Provide groupIds[] or set includeUngrouped" },
        { status: 400 }
      );
    }

    const accounts = await prisma.trackedAccount.findMany({
      include: {
        groups: { select: { groupId: true } },
        media: {
          include: { snapshots: { orderBy: { snapshotAt: "desc" }, take: 1 } },
        },
      },
    });

    const groupIdSet = new Set(groupIds ?? []);
    const eligible = accounts.filter((a) => {
      if (a.groups.length === 0) return Boolean(includeUngrouped);
      return a.groups.some((g) => groupIdSet.has(g.groupId));
    });

    const existing = await prisma.scheduleEntry.findMany({ select: { username: true } });
    const existingSet = new Set(existing.map((e) => e.username));

    const summary = { ODLIČAN: 0, DOBAR: 0, LOŠI: 0, SHADOWBANNED: 0 };
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const a of eligible) {
      const sortedMedia = [...a.media].sort((x, y) => {
        const xt = x.publishedAt?.getTime() ?? 0;
        const yt = y.publishedAt?.getTime() ?? 0;
        if (xt !== yt) return yt - xt;
        return y.igMediaId.localeCompare(x.igMediaId);
      });

      let total = 0;
      let count = 0;
      for (const m of sortedMedia.slice(0, 36)) {
        if (m.snapshots[0]) {
          total += m.snapshots[0].viewCount;
          count++;
        }
      }
      const avg = count > 0 ? Math.round(total / count) : 0;
      const category = categoryFor(avg);

      const wasInScheduler = existingSet.has(a.username);

      if (wasInScheduler && skipExisting) {
        skipped++;
        continue;
      }

      if (wasInScheduler) {
        await prisma.scheduleEntry.update({
          where: { username: a.username },
          data: { category },
        });
        updated++;
      } else {
        await prisma.scheduleEntry.create({
          data: {
            username: a.username,
            category,
            expiryDate: null,
            note: null,
          },
        });
        added++;
      }

      summary[category as keyof typeof summary]++;
    }

    return NextResponse.json({
      success: true,
      eligible: eligible.length,
      added,
      updated,
      skipped,
      summary,
    });
  } catch (error) {
    console.error("Scheduler import-from-tracker error:", error);
    return NextResponse.json(
      { error: "Failed to import", message: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
