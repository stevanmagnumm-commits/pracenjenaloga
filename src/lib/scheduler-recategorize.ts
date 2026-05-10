import { prisma } from "@/lib/db";

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

export interface RecategorizeResult {
  total: number;
  changed: number;
  skipped: number;
  orphansRemoved: number;
  removedUsernames: string[];
  changes: Array<{ username: string; from: string; to: string; avgViews: number }>;
}

/**
 * Recalculates the scheduler category for every ScheduleEntry that maps to a
 * tracked account, based on the average view count of the account's last 36
 * reels. Only accounts with at least one snapshotted media are touched — newly
 * added or never-refreshed accounts keep whatever category they had.
 */
export async function recategorizeScheduler(): Promise<RecategorizeResult> {
  const entries = await prisma.scheduleEntry.findMany();
  if (entries.length === 0) {
    return { total: 0, changed: 0, skipped: 0, orphansRemoved: 0, removedUsernames: [], changes: [] };
  }

  const usernames = entries.map((e) => e.username);

  // Find every tracker account that still has a row, regardless of whether
  // it has media yet. Used both for category calc and for orphan detection.
  const trackerUsernames = await prisma.trackedAccount.findMany({
    where: { username: { in: usernames } },
    select: { username: true },
  });
  const trackerSet = new Set(trackerUsernames.map((a) => a.username));

  // Orphan cleanup: scheduler entries whose underlying tracker account has
  // been deleted. These are leftover ghosts and we drop them outright.
  const orphans = entries.filter((e) => !trackerSet.has(e.username));
  let orphansRemoved = 0;
  const removedUsernames: string[] = [];
  if (orphans.length > 0) {
    const orphanUsernames = orphans.map((e) => e.username);
    const result = await prisma.scheduleEntry.deleteMany({
      where: { username: { in: orphanUsernames } },
    });
    orphansRemoved = result.count;
    removedUsernames.push(...orphanUsernames);
  }

  // Re-fetch full data for the surviving entries.
  const survivingUsernames = entries.filter((e) => trackerSet.has(e.username)).map((e) => e.username);
  const accounts = await prisma.trackedAccount.findMany({
    where: { username: { in: survivingUsernames } },
    include: {
      media: {
        include: {
          snapshots: {
            orderBy: { snapshotAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  const accountMap = new Map(accounts.map((a) => [a.username, a]));

  let changed = 0;
  let skipped = 0;
  const changes: RecategorizeResult["changes"] = [];

  for (const entry of entries) {
    if (!trackerSet.has(entry.username)) continue; // already deleted as orphan
    const account = accountMap.get(entry.username);
    if (!account) {
      skipped++;
      continue;
    }

    const sortedByRecency = [...account.media].sort((a, b) => {
      const at = a.publishedAt?.getTime() ?? 0;
      const bt = b.publishedAt?.getTime() ?? 0;
      if (at !== bt) return bt - at;
      return b.igMediaId.localeCompare(a.igMediaId);
    });

    let totalViews = 0;
    let count = 0;
    for (const m of sortedByRecency.slice(0, 36)) {
      const snap = m.snapshots[0];
      if (snap) {
        totalViews += snap.viewCount;
        count++;
      }
    }

    if (count === 0) {
      skipped++;
      continue;
    }

    const avgViews = Math.round(totalViews / count);
    const newCategory = categoryFor(avgViews);

    if (newCategory !== entry.category) {
      await prisma.scheduleEntry.update({
        where: { id: entry.id },
        data: { category: newCategory },
      });
      changes.push({
        username: entry.username,
        from: entry.category,
        to: newCategory,
        avgViews,
      });
      changed++;
    }
  }

  return { total: entries.length, changed, skipped, orphansRemoved, removedUsernames, changes };
}
