import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { initialImport } from "@/lib/refresh";
import { addToSchedulerWithExpiryDate } from "@/lib/scheduler-add";

export const dynamic = "force-dynamic";

interface BulkProgress {
  total: number;
  completed: number;
  current: string | null;
  successes: string[];
  errors: Array<{ username: string; error: string }>;
  running: boolean;
}

let progress: BulkProgress = {
  total: 0,
  completed: 0,
  current: null,
  successes: [],
  errors: [],
  running: false,
};

/**
 * POST /api/creators/accounts/add-to-tracker
 * Body: { ids: string[], postsLeft?: number, scheduledBy?: string }
 *
 * For each CreatorAccount id provided:
 *   1. Skip if username already in tracker
 *   2. initialImport(username) — pulls profile + reels
 *   3. If postsLeft is set, create/update ScheduleEntry with expiry=today+postsLeft
 *   4. Stamp scheduledBy/scheduledAt/postsLeft back onto the CreatorAccount row
 */
export async function POST(request: NextRequest) {
  if (progress.running) {
    return NextResponse.json(
      { error: "Add-to-tracker already running", progress },
      { status: 409 }
    );
  }

  const body = await request.json();
  const { ids } = body as { ids: string[] };

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
  // Skip placeholder drafts and visual separator rows — neither represents a
  // real Instagram account that can be imported.
  const validRows = rows.filter(
    (r) => r.kind !== "separator" && !r.username.startsWith("__draft_") && !r.username.startsWith("__separator_"),
  );

  // Dedup: skip usernames that are already in the main Tracker.
  const existingTracked = await prisma.trackedAccount.findMany({
    where: { username: { in: validRows.map((r) => r.username) } },
    select: { username: true },
  });
  const existingSet = new Set(existingTracked.map((e) => e.username));
  const importableRows = validRows.filter((r) => !existingSet.has(r.username));

  if (importableRows.length === 0) {
    return NextResponse.json({
      error: "Nothing to import — all selected accounts are already in the Tracker (or are drafts/separators).",
    }, { status: 400 });
  }

  // Use UTC midnight today so postsLeft math doesn't drift across timezones.
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const MS_PER_DAY = 86_400_000;

  // Stamp scheduling metadata up front so even mid-run the UI shows who
  // scheduled each row and the computed posts-left value.
  const stampedAt = new Date();
  for (const r of importableRows) {
    let postsLeftForRow: number | null = null;
    if (r.expiryDate) {
      const diffDays = Math.round((r.expiryDate.getTime() - todayUtc) / MS_PER_DAY);
      postsLeftForRow = Math.max(0, diffDays);
    }
    await prisma.creatorAccount.update({
      where: { id: r.id },
      data: {
        scheduledAt: stampedAt,
        postsLeft: postsLeftForRow,
      },
    });
  }

  progress = {
    total: importableRows.length,
    completed: 0,
    current: null,
    successes: [],
    errors: [],
    running: true,
  };

  (async () => {
    for (const row of importableRows) {
      progress.current = row.username;
      try {
        // Create the tracked-account stub. Dedup is enforced above so we
        // never overwrite an existing entry.
        await prisma.trackedAccount.create({
          data: {
            igUserId: "",
            username: row.username,
            fullName: "",
            bio: "",
            isVerified: false,
          },
        });
        await initialImport(row.username);

        // Use the row's expiry date as the scheduler's expiry directly.
        if (row.expiryDate) {
          await addToSchedulerWithExpiryDate(row.username, row.expiryDate);
        }

        progress.successes.push(row.username);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "unknown";
        console.error(`[creator-add-to-tracker] @${row.username}:`, msg);
        progress.errors.push({ username: row.username, error: msg });
      }
      progress.completed++;
    }
    progress.current = null;
    progress.running = false;
  })();

  return NextResponse.json({
    started: true,
    total: importableRows.length,
    skippedDuplicates: validRows.length - importableRows.length,
  });
}

export async function GET() {
  return NextResponse.json(progress);
}
