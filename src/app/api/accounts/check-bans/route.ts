import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkAccountBan } from "@/lib/refresh";
import { recategorizeScheduler } from "@/lib/scheduler-recategorize";

export const dynamic = "force-dynamic";

interface BanCheckProgress {
  total: number;
  completed: number;
  current: string | null;
  alive: number;
  banned: number;
  inconclusive: number;
  recovered: string[]; // accounts that went possibly_banned -> active
  newlyBanned: string[]; // accounts that went active -> possibly_banned
  running: boolean;
}

let progress: BanCheckProgress = {
  total: 0,
  completed: 0,
  current: null,
  alive: 0,
  banned: 0,
  inconclusive: 0,
  recovered: [],
  newlyBanned: [],
  running: false,
};

export async function GET() {
  return NextResponse.json(progress, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

/**
 * POST /api/accounts/check-bans  { ids: string[] }
 *
 * Checks ONLY the ban status of the selected accounts (cheap profile probe,
 * no reels). Un-bans recovered accounts and flags newly-missing ones, then
 * recategorizes the scheduler so they land in the right category.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { ids?: string[] } | null;
  if (!body?.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
    return NextResponse.json({ error: "ids[] required" }, { status: 400 });
  }

  if (progress.running) {
    return NextResponse.json(
      { error: "A ban check is already running", progress },
      { status: 409 },
    );
  }

  const accounts = await prisma.trackedAccount.findMany({
    where: { id: { in: body.ids } },
    select: { id: true, username: true, status: true },
  });

  progress = {
    total: accounts.length,
    completed: 0,
    current: null,
    alive: 0,
    banned: 0,
    inconclusive: 0,
    recovered: [],
    newlyBanned: [],
    running: true,
  };

  (async () => {
    for (const account of accounts) {
      progress.current = account.username;
      const wasBanned = account.status === "possibly_banned";
      try {
        const result = await checkAccountBan(account.id);
        if (result === "alive") {
          progress.alive++;
          if (wasBanned) progress.recovered.push(account.username);
        } else if (result === "banned") {
          progress.banned++;
          if (!wasBanned) progress.newlyBanned.push(account.username);
        } else {
          progress.inconclusive++;
        }
      } catch (error) {
        console.error(`[checkBans] @${account.username}:`, error);
        progress.inconclusive++;
      }
      progress.completed++;
    }

    // Move recovered/newly-banned accounts into the right scheduler category
    progress.current = "Recategorizing scheduler...";
    try {
      await recategorizeScheduler();
    } catch (error) {
      console.error(`[checkBans] Recategorize failed:`, error);
    }

    progress.current = null;
    progress.running = false;
    console.log(
      `[checkBans] Done. ${progress.alive} alive, ${progress.banned} banned, ${progress.inconclusive} inconclusive. Recovered ${progress.recovered.length}, newly banned ${progress.newlyBanned.length}.`,
    );
  })();

  return NextResponse.json({ started: true, total: accounts.length });
}
