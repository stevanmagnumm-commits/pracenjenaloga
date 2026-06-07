import { NextRequest, NextResponse } from "next/server";
import { refreshAccount } from "@/lib/refresh";
import { recategorizeScheduler } from "@/lib/scheduler-recategorize";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

interface RefreshAllProgress {
  total: number;
  completed: number;
  current: string | null;
  errors: Array<{ username: string; error: string }>;
  running: boolean;
}

let refreshAllProgress: RefreshAllProgress = {
  total: 0,
  completed: 0,
  current: null,
  errors: [],
  running: false,
};

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("accountId");
  const all = searchParams.get("all");

  if (accountId) {
    try {
      await refreshAccount(accountId);
      return NextResponse.json({ success: true, message: "Refresh complete" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[refreshAccount] Failed for ${accountId}:`, message);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // Refresh only a specific set of selected accounts (e.g. to spot-check
  // whether they're banned). Shares the same progress object as "refresh all"
  // so the existing progress UI / polling works unchanged.
  const body = await request.json().catch(() => null) as { ids?: string[] } | null;
  if (body?.ids && Array.isArray(body.ids) && body.ids.length > 0) {
    if (refreshAllProgress.running) {
      return NextResponse.json(
        { error: "Refresh already in progress", progress: refreshAllProgress },
        { status: 409 },
      );
    }

    const accounts = await prisma.trackedAccount.findMany({
      where: { id: { in: body.ids } },
      orderBy: [{ priority: "asc" }, { lastRefreshedAt: "asc" }],
      select: { id: true, username: true },
    });

    refreshAllProgress = {
      total: accounts.length,
      completed: 0,
      current: null,
      errors: [],
      running: true,
    };

    (async () => {
      for (const account of accounts) {
        refreshAllProgress.current = account.username;
        try {
          await refreshAccount(account.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error(`[refreshSelected] Failed for @${account.username}:`, message);
          refreshAllProgress.errors.push({ username: account.username, error: message });
        }
        refreshAllProgress.completed++;
      }
      // Recategorize so any newly-banned/healthy accounts move correctly
      refreshAllProgress.current = "Recategorizing scheduler...";
      try {
        await recategorizeScheduler();
      } catch (error) {
        console.error(`[refreshSelected] Recategorize failed:`, error);
      }
      refreshAllProgress.current = null;
      refreshAllProgress.running = false;
    })();

    return NextResponse.json({
      message: `Started refreshing ${accounts.length} selected accounts`,
      progress: refreshAllProgress,
    });
  }

  if (all === "true") {
    if (refreshAllProgress.running) {
      return NextResponse.json(
        { error: "Refresh already in progress", progress: refreshAllProgress },
        { status: 409 }
      );
    }

    const groupId = searchParams.get("groupId");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const whereClause = groupId
      ? {
          groups: { some: { groupId } },
          OR: [
            { lastRefreshedAt: null },
            { lastRefreshedAt: { lt: twoHoursAgo } },
          ],
        }
      : {
          OR: [
            { lastRefreshedAt: null },
            { lastRefreshedAt: { lt: twoHoursAgo } },
          ],
        };

    const accounts = await prisma.trackedAccount.findMany({
      where: whereClause,
      orderBy: [{ priority: "asc" }, { lastRefreshedAt: "asc" }],
      select: { id: true, username: true },
    });

    refreshAllProgress = {
      total: accounts.length,
      completed: 0,
      current: null,
      errors: [],
      running: true,
    };

    (async () => {
      for (const account of accounts) {
        refreshAllProgress.current = account.username;
        try {
          await refreshAccount(account.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error(`[refreshAll] Failed for @${account.username}:`, message);
          refreshAllProgress.errors.push({ username: account.username, error: message });
        }
        refreshAllProgress.completed++;
      }
      refreshAllProgress.current = "Recategorizing scheduler...";
      try {
        const result = await recategorizeScheduler();
        console.log(
          `[refreshAll] Scheduler recategorized: ${result.changed} changed, ${result.orphansRemoved} orphans removed (of ${result.total} total, ${result.skipped} skipped)`
        );
        if (result.removedUsernames.length > 0) {
          console.log(`[refreshAll]   Removed orphans: ${result.removedUsernames.map((u) => "@" + u).join(", ")}`);
        }
        if (result.changes.length > 0) {
          for (const c of result.changes) {
            console.log(`[refreshAll]   @${c.username}: ${c.from} → ${c.to} (avg ${c.avgViews})`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`[refreshAll] Recategorize failed:`, message);
      }
      refreshAllProgress.current = null;
      refreshAllProgress.running = false;
    })();

    return NextResponse.json({
      message: `Started refreshing ${accounts.length} accounts`,
      progress: refreshAllProgress,
    });
  }

  return NextResponse.json({ error: "Provide accountId or all=true" }, { status: 400 });
}

export async function GET() {
  return NextResponse.json(refreshAllProgress, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
