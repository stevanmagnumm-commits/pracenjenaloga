import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkMultipleAccounts } from "@/lib/snapchat-check";
import { sendTelegramMessage, formatBanAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";

interface CheckProgress {
  total: number;
  completed: number;
  current: string | null;
  alive: number;
  banned: number;
  errors: number;
  running: boolean;
}

let checkProgress: CheckProgress = {
  total: 0,
  completed: 0,
  current: null,
  alive: 0,
  banned: 0,
  errors: 0,
  running: false,
};

export async function POST(request: NextRequest) {
  if (checkProgress.running) {
    return NextResponse.json(
      { error: "Check already in progress", progress: checkProgress },
      { status: 409 }
    );
  }

  const groupId = new URL(request.url).searchParams.get("groupId");

  const whereClause = groupId ? { groups: { some: { groupId } } } : {};

  const accounts = await prisma.snapchatAccount.findMany({
    where: whereClause,
    select: { id: true, username: true, status: true },
    orderBy: { username: "asc" },
  });

  if (accounts.length === 0) {
    return NextResponse.json({ error: "No accounts to check" }, { status: 400 });
  }

  const previousStatuses = new Map(accounts.map((a) => [a.id, a.status]));

  checkProgress = {
    total: accounts.length,
    completed: 0,
    current: null,
    alive: 0,
    banned: 0,
    errors: 0,
    running: true,
  };

  (async () => {
    const newlyBanned: string[] = [];

    try {
      await checkMultipleAccounts(
        accounts,
        async (accountId, result) => {
          const prevStatus = previousStatuses.get(accountId);

          // "error" = untrustworthy: keep previous status, just record attempt.
          if (result.status === "error") {
            checkProgress.errors++;
            await prisma.snapchatAccount.update({
              where: { id: accountId },
              data: { lastCheckedAt: new Date() },
            });
            return;
          }

          await prisma.snapchatAccount.update({
            where: { id: accountId },
            data: {
              status: result.status,
              displayName: result.displayName,
              lastCheckedAt: new Date(),
            },
          });

          await prisma.snapchatStatusLog.create({
            data: {
              accountId,
              status: result.status,
            },
          });

          if (result.status === "alive") checkProgress.alive++;
          else checkProgress.banned++;

          if (result.status === "banned" && prevStatus !== "banned") {
            newlyBanned.push(result.username);
          }
        },
        (completed, _total, current) => {
          checkProgress.completed = completed;
          checkProgress.current = current || null;
        },
      );

      console.log(`[api-check] Done: ${checkProgress.alive} alive, ${checkProgress.banned} banned, ${checkProgress.errors} error, ${newlyBanned.length} newly banned`);

      if (newlyBanned.length > 0) {
        console.log(`[api-check] Sending ban alert for: ${newlyBanned.join(", ")}`);
        const message = formatBanAlert(newlyBanned, accounts.length, checkProgress.alive, checkProgress.banned);
        const sent = await sendTelegramMessage(message);
        console.log(`[api-check] Telegram sent: ${sent}`);
      } else {
        console.log("[api-check] No newly banned accounts");
      }
    } catch (err) {
      console.error("[api-check] Error during batch check:", err);
    } finally {
      checkProgress.completed = checkProgress.total;
      checkProgress.current = null;
      checkProgress.running = false;
    }
  })();

  return NextResponse.json({
    message: `Started checking ${accounts.length} accounts`,
    progress: checkProgress,
  });
}

export async function GET() {
  return NextResponse.json(checkProgress, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
