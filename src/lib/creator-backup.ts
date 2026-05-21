import { writeFile, mkdir, readdir, unlink, stat } from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db";

/**
 * Where the rolling XLSX snapshots are written. Override with BACKUP_DIR env
 * (e.g. `/var/www/tracker/backups` on the server).
 */
function backupDir(): string {
  return process.env.BACKUP_DIR || path.join(process.cwd(), "backups");
}

const MAX_KEEP = 168; // keep ~7 days of hourly snapshots

function dateStr(d: Date | null | undefined): string {
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Snapshots EVERY creator into a single multi-sheet XLSX. One worksheet per
 * creator (named after the creator), one row per account with separator rows
 * preserved as visual day-headers. Returns the absolute file path on success.
 */
export async function backupAllCreators(): Promise<string | null> {
  const creators = await prisma.creator.findMany({
    include: { accounts: { orderBy: { createdAt: "asc" } } },
    orderBy: { name: "asc" },
  });
  if (creators.length === 0) return null;

  const wb = XLSX.utils.book_new();
  const header = [
    "Type",
    "Username",
    "Password",
    "2FA",
    "Proxy",
    "Notes",
    "Snap",
    "Scheduled By",
    "Expires",
    "Posts Left",
    "Scheduled At",
  ];

  for (const c of creators) {
    const rows: (string | number | null)[][] = [
      [`Creator: ${c.name} (slug=${c.slug})`],
      [`Access: ${c.accessUsername ?? ""} / ${c.accessPassword ?? ""}`],
      [],
      header,
    ];
    for (const a of c.accounts) {
      if (a.kind === "separator") {
        rows.push([
          "DAY",
          `=== ${dateStr(a.expiryDate)} ===`,
          "", "", "", "", "", "", "", "", "",
        ]);
        continue;
      }
      if (a.username.startsWith("__draft_") || a.username.startsWith("__separator_")) continue;
      rows.push([
        "account",
        a.username,
        a.password ?? "",
        a.twoFa ?? "",
        a.proxy ?? "",
        a.notes ?? "",
        a.snapAccount ?? "",
        a.scheduledBy ?? "",
        dateStr(a.expiryDate),
        a.postsLeft ?? "",
        a.scheduledAt ? a.scheduledAt.toISOString() : "",
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [
      { wch: 8 }, { wch: 22 }, { wch: 16 }, { wch: 24 },
      { wch: 22 }, { wch: 24 }, { wch: 18 }, { wch: 14 },
      { wch: 12 }, { wch: 10 }, { wch: 22 },
    ];
    // Excel sheet names cap at 31 chars and can't contain []:*?/\
    const sheetName = (c.name || c.slug).slice(0, 28).replace(/[\\/?*[\]:]/g, "_") || c.slug;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  const dir = backupDir();
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `creators-${stamp}.xlsx`);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  await writeFile(file, buf);

  // Prune old snapshots so the disk doesn't fill up forever
  await pruneOldBackups(dir);
  return file;
}

async function pruneOldBackups(dir: string) {
  try {
    const files = await readdir(dir);
    const xlsx = files.filter((f) => f.startsWith("creators-") && f.endsWith(".xlsx"));
    if (xlsx.length <= MAX_KEEP) return;
    const withTimes = await Promise.all(
      xlsx.map(async (f) => {
        const full = path.join(dir, f);
        const s = await stat(full);
        return { full, mtime: s.mtimeMs };
      }),
    );
    withTimes.sort((a, b) => a.mtime - b.mtime);
    const toDelete = withTimes.slice(0, withTimes.length - MAX_KEEP);
    for (const f of toDelete) {
      await unlink(f.full).catch(() => {});
    }
  } catch (e) {
    console.warn("[creator-backup] prune failed:", e);
  }
}
