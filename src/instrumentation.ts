export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const cron = await import("node-cron");
    const { ENABLE_SNAPCHAT } = await import("@/lib/modules");
    const { backupAllCreators } = await import("@/lib/creator-backup");

    // Snapchat module is optional per deployment — skip all of its cron work
    // (and the Telegram reports it sends) when disabled for this instance.
    if (ENABLE_SNAPCHAT) {
      const { runSnapchatCheck } = await import("@/lib/snapchat-scheduled-check");

      // Every 2 hours during active window: 10,12,14,16,18,20,22,0
      // Morning report at 10:00 always sends full status
      cron.default.schedule("0 10,12,14,16,18,20,22 * * *", async () => {
        const hour = new Date().getHours();
        const isMorningReport = hour === 10;
        console.log(`[scheduler] Running ${isMorningReport ? "morning report" : "2-hour"} Snapchat check (${hour}:00)...`);
        await runSnapchatCheck({ sendReportAlways: isMorningReport });
      });

      // Midnight check (part of the active window)
      cron.default.schedule("0 0 * * *", async () => {
        console.log("[scheduler] Running midnight Snapchat check...");
        await runSnapchatCheck();
      });
    }

    // Hourly creator-sheets backup → /backups/creators-<timestamp>.xlsx
    // Override location with BACKUP_DIR env (e.g. point at a mounted volume).
    cron.default.schedule("5 * * * *", async () => {
      try {
        const file = await backupAllCreators();
        if (file) console.log(`[scheduler] Creator backup written: ${file}`);
      } catch (e) {
        console.warn("[scheduler] Creator backup failed:", e);
      }
    });
    // Also run one snapshot at boot so we have something on day 1
    backupAllCreators().then(
      (f) => f && console.log(`[scheduler] Initial creator backup: ${f}`),
    ).catch(() => {});

    // Heartbeat every 30 min to confirm cron is alive
    cron.default.schedule("*/30 * * * *", () => {
      console.log(`[scheduler] Heartbeat — ${new Date().toLocaleTimeString()}`);
    });

    // Self-ping every 5 min to keep the dev server from idling. Use the
    // instance's own PORT so a second instance never pings the first one.
    const selfPort = process.env.PORT || "3000";
    setInterval(async () => {
      try {
        await fetch(`http://localhost:${selfPort}/api/snapchat/check`);
      } catch {}
    }, 5 * 60 * 1000);

    console.log("[scheduler] Snapchat cron active: checks at 10,12,14,16,18,20,22,0 | pause 2-9 | morning report at 10:00");
    console.log("[scheduler] Creator backup cron active: every hour @ :05");
  }
}
