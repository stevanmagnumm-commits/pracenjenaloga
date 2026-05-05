export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const cron = await import("node-cron");
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

    // Heartbeat every 30 min to confirm cron is alive
    cron.default.schedule("*/30 * * * *", () => {
      console.log(`[scheduler] Heartbeat — ${new Date().toLocaleTimeString()}`);
    });

    // Self-ping every 5 min to keep the dev server from idling
    setInterval(async () => {
      try {
        await fetch("http://localhost:3000/api/snapchat/check");
      } catch {}
    }, 5 * 60 * 1000);

    console.log("[scheduler] Snapchat cron active: checks at 10,12,14,16,18,20,22,0 | pause 2-9 | morning report at 10:00");
  }
}
