import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

interface PreviewRow {
  id: string;
  username: string;
  scheduledBy: string | null;
  expiryDate: string | null;
  postsLeft: number | null;
  alreadyInTracker: boolean;
  skipReason?: "draft" | "separator" | "no-username";
}

/**
 * POST /api/creators/accounts/add-to-tracker/preview
 * Body: { ids: string[] }
 *
 * Computes everything the confirmation dialog needs to show before the user
 * commits an import. Specifically:
 *   - which usernames are already in the main Tracker (will be skipped)
 *   - per-row scheduledBy + expiryDate as set on the sheet
 *   - postsLeft computed from expiryDate (or null if no expiry)
 *   - aggregate counts by scheduler name (Vuk / Jocke / Mike / other)
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { ids } = body as { ids?: string[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "ids[] required" }, { status: 400 });
  }

  const rows = await prisma.creatorAccount.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      kind: true,
      username: true,
      scheduledBy: true,
      expiryDate: true,
    },
  });

  const realUsernames = rows
    .filter((r) => r.kind !== "separator" && !r.username.startsWith("__draft_") && !r.username.startsWith("__separator_"))
    .map((r) => r.username);

  const existing = await prisma.trackedAccount.findMany({
    where: { username: { in: realUsernames } },
    select: { username: true },
  });
  const existingSet = new Set(existing.map((e) => e.username));

  // Use the start of UTC today to keep postsLeft math timezone-stable.
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const MS_PER_DAY = 86_400_000;

  const preview: PreviewRow[] = rows.map((r) => {
    let skipReason: PreviewRow["skipReason"] | undefined;
    if (r.kind === "separator" || r.username.startsWith("__separator_")) {
      skipReason = "separator";
    } else if (r.username.startsWith("__draft_")) {
      skipReason = "draft";
    } else if (!r.username || !r.username.trim()) {
      skipReason = "no-username";
    }

    let postsLeft: number | null = null;
    if (r.expiryDate) {
      const exp = r.expiryDate.getTime();
      const diffDays = Math.round((exp - todayUtc) / MS_PER_DAY);
      postsLeft = Math.max(0, diffDays);
    }

    return {
      id: r.id,
      username: r.username.startsWith("__") ? "" : r.username,
      scheduledBy: r.scheduledBy,
      expiryDate: r.expiryDate ? r.expiryDate.toISOString() : null,
      postsLeft,
      alreadyInTracker: existingSet.has(r.username),
      skipReason,
    };
  });

  const importable = preview.filter((p) => !p.skipReason && !p.alreadyInTracker);
  const alreadyInTracker = preview.filter((p) => !p.skipReason && p.alreadyInTracker);
  const skipped = preview.filter((p) => p.skipReason);

  const bySchedulerBy: Record<string, number> = {};
  for (const p of importable) {
    const key = p.scheduledBy || "(unassigned)";
    bySchedulerBy[key] = (bySchedulerBy[key] || 0) + 1;
  }
  const withExpiry = importable.filter((p) => p.expiryDate !== null).length;
  const withoutExpiry = importable.length - withExpiry;

  return NextResponse.json({
    total: preview.length,
    rows: preview,
    importable: importable.length,
    alreadyInTracker: alreadyInTracker.length,
    alreadyInTrackerUsernames: alreadyInTracker.map((p) => p.username),
    skipped: skipped.length,
    bySchedulerBy,
    withExpiry,
    withoutExpiry,
  });
}
