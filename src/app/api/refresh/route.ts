import { NextRequest, NextResponse } from "next/server";
import { refreshAccount } from "@/lib/refresh";
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
