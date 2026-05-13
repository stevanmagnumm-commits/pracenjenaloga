import { prisma } from "@/lib/db";

const CATEGORY_THRESHOLDS = [
  { min: 800, category: "ODLIČAN" },
  { min: 200, category: "DOBAR" },
  { min: 50, category: "LOŠI" },
  { min: 0, category: "SHADOWBANNED" },
];

function categoryFor(avg: number): string {
  for (const t of CATEGORY_THRESHOLDS) {
    if (avg >= t.min) return t.category;
  }
  return "SHADOWBANNED";
}

/**
 * Compute the avg-of-last-36-reels for a tracked account based on its
 * media + latest snapshot per item. Returns null when there are no
 * snapshots to average yet (brand new account, or banned with no reels).
 */
async function computeAvg36(accountId: string): Promise<number | null> {
  const media = await prisma.media.findMany({
    where: { accountId },
    include: { snapshots: { orderBy: { snapshotAt: "desc" }, take: 1 } },
  });
  media.sort((a, b) => {
    const at = a.publishedAt?.getTime() ?? 0;
    const bt = b.publishedAt?.getTime() ?? 0;
    if (at !== bt) return bt - at;
    return b.igMediaId.localeCompare(a.igMediaId);
  });
  let total = 0;
  let count = 0;
  for (const m of media.slice(0, 36)) {
    const snap = m.snapshots[0];
    if (snap) {
      total += snap.viewCount;
      count++;
    }
  }
  return count > 0 ? Math.round(total / count) : null;
}

/**
 * Compute UTC midnight today + N days. Used so the "20 posts left"
 * scheduling math always lands on a stable calendar date regardless of
 * server timezone.
 */
function expiryFromPostsLeft(postsLeft: number): Date {
  const today = new Date();
  return new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() + postsLeft,
  ));
}

/**
 * Create or update a ScheduleEntry for a tracked account that was just
 * imported via /api/accounts (single or bulk). Determines the category
 * automatically from the freshly scraped media, and sets the expiry date
 * to today+postsLeft days when provided.
 *
 * Safe to call even when the import returned 0 reels — those accounts
 * land in SHADOWBANNED so the user still sees them in the scheduler.
 */
export async function addToSchedulerWithExpiry(
  username: string,
  postsLeft: number | null | undefined,
): Promise<{ category: string; avg: number | null } | null> {
  if (postsLeft === null || postsLeft === undefined) return null;
  if (!Number.isFinite(postsLeft) || postsLeft < 0) return null;

  const account = await prisma.trackedAccount.findUnique({
    where: { username },
    select: { id: true },
  });
  if (!account) return null;

  const avg = await computeAvg36(account.id);
  const category = avg === null ? "SHADOWBANNED" : categoryFor(avg);
  const expiryDate = expiryFromPostsLeft(postsLeft);

  await prisma.scheduleEntry.upsert({
    where: { username },
    update: { category, expiryDate },
    create: { username, category, expiryDate },
  });

  return { category, avg };
}
