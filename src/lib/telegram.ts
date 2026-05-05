export async function sendTelegramMessage(text: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";

  if (!botToken || !chatId) {
    console.log("[telegram] Bot token or chat ID not configured, skipping notification");
    console.log(`[telegram] TOKEN present: ${!!botToken}, CHAT_ID present: ${!!chatId}`);
    return false;
  }

  console.log(`[telegram] Sending message (${text.length} chars)...`);

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[telegram] Failed to send message:", err);
      return false;
    }

    console.log("[telegram] Message sent successfully");
    return true;
  } catch (err) {
    console.error("[telegram] Error sending message:", err);
    return false;
  }
}

export function formatBanAlert(
  newlyBanned: string[],
  totalChecked: number,
  aliveCount: number,
  bannedCount: number,
): string {
  const lines: string[] = [];

  lines.push("🚨 <b>SNAPCHAT BAN ALERT</b>");
  lines.push("");
  lines.push(`<b>${newlyBanned.length}</b> account${newlyBanned.length === 1 ? "" : "s"} newly banned:`);
  for (const username of newlyBanned) {
    lines.push(`  • @${username}`);
  }
  lines.push("");
  lines.push(`Checked at: ${new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}`);
  lines.push(`Total: ${totalChecked} | Alive: ${aliveCount} | Banned: ${bannedCount}`);

  return lines.join("\n");
}

export function formatStatusReport(
  totalAccounts: number,
  aliveCount: number,
  bannedCount: number,
  allBannedUsernames: string[],
  newlyBanned: string[],
): string {
  const lines: string[] = [];
  const time = new Date().toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  lines.push("📋 <b>SNAPCHAT STATUS REPORT</b>");
  lines.push("");
  lines.push(`✅ Alive: <b>${aliveCount}</b>`);
  lines.push(`❌ Banned: <b>${bannedCount}</b>`);
  lines.push(`📊 Total: <b>${totalAccounts}</b>`);
  lines.push("");

  if (newlyBanned.length > 0) {
    lines.push(`🆕 <b>${newlyBanned.length} newly banned since last check:</b>`);
    for (const u of newlyBanned) {
      lines.push(`  • @${u}`);
    }
    lines.push("");
  }

  if (allBannedUsernames.length > 0) {
    lines.push(`<b>All banned accounts (${allBannedUsernames.length}):</b>`);
    for (const u of allBannedUsernames) {
      lines.push(`  • @${u}`);
    }
    lines.push("");
  } else {
    lines.push("🎉 No banned accounts!");
    lines.push("");
  }

  lines.push(`Report generated: ${time}`);

  return lines.join("\n");
}
