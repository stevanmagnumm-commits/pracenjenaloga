import { prisma } from "@/lib/db";
import { checkMultipleAccounts } from "@/lib/snapchat-check";
import { sendTelegramMessage, formatBanAlert, formatStatusReport } from "@/lib/telegram";

let isRunning = false;

export function isScheduledCheckRunning() {
  return isRunning;
}

export async function runSnapchatCheck(options?: { sendReportAlways?: boolean }) {
  if (isRunning) {
    console.log("[snap-scheduler] Check already running, skipping");
    return;
  }

  isRunning = true;
  console.log("[snap-scheduler] Starting scheduled check...");

  try {
    const accounts = await prisma.snapchatAccount.findMany({
      select: { id: true, username: true, status: true },
      orderBy: { username: "asc" },
    });

    if (accounts.length === 0) {
      console.log("[snap-scheduler] No accounts to check");
      return;
    }

    const previousStatuses = new Map(accounts.map((a) => [a.id, a.status]));
    const newlyBanned: string[] = [];
    let aliveCount = 0;
    let bannedCount = 0;

    await checkMultipleAccounts(
      accounts,
      async (accountId, result) => {
        const prevStatus = previousStatuses.get(accountId);

        await prisma.snapchatAccount.update({
          where: { id: accountId },
          data: {
            status: result.status,
            displayName: result.displayName,
            lastCheckedAt: new Date(),
          },
        });

        await prisma.snapchatStatusLog.create({
          data: { accountId, status: result.status },
        });

        if (result.status === "alive") aliveCount++;
        else bannedCount++;

        if (result.status === "banned" && prevStatus !== "banned") {
          newlyBanned.push(result.username);
        }
      },
    );

    console.log(`[snap-scheduler] Done: ${aliveCount} alive, ${bannedCount} banned, ${newlyBanned.length} newly banned`);

    if (newlyBanned.length > 0) {
      console.log(`[snap-scheduler] Sending ban alert for: ${newlyBanned.join(", ")}`);
      const message = formatBanAlert(newlyBanned, accounts.length, aliveCount, bannedCount);
      const sent = await sendTelegramMessage(message);
      console.log(`[snap-scheduler] Ban alert sent: ${sent}`);
    } else {
      console.log("[snap-scheduler] No newly banned accounts, no alert needed");
    }

    if (options?.sendReportAlways) {
      const allBanned = accounts
        .filter((a) => {
          const prev = previousStatuses.get(a.id);
          return prev === "banned" || newlyBanned.includes(a.username);
        })
        .map((a) => a.username);

      // Re-fetch to get latest statuses
      const updated = await prisma.snapchatAccount.findMany({
        where: { status: "banned" },
        select: { username: true },
        orderBy: { username: "asc" },
      });

      const report = formatStatusReport(
        accounts.length,
        aliveCount,
        bannedCount,
        updated.map((a) => a.username),
        newlyBanned,
      );
      await sendTelegramMessage(report);
    }
  } catch (err) {
    console.error("[snap-scheduler] Error during scheduled check:", err);
  } finally {
    isRunning = false;
  }
}
