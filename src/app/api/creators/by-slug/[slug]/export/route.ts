import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import * as XLSX from "xlsx";

export const dynamic = "force-dynamic";

function dateStr(d: Date | null | undefined): string {
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * GET /api/creators/by-slug/<slug>/export
 * Downloads the creator's entire sheet as an XLSX file. Separator rows are
 * emitted as visually distinct "=== day ===" rows so the day-grouping the
 * user worked with is preserved in the backup.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const creator = await prisma.creator.findUnique({
    where: { slug },
    include: { accounts: { orderBy: { createdAt: "asc" } } },
  });
  if (!creator) return NextResponse.json({ error: "Not found" }, { status: 404 });

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

  const rows: (string | number | null)[][] = [header];
  for (const a of creator.accounts) {
    if (a.kind === "separator") {
      rows.push([
        "DAY",
        `=== ${dateStr(a.expiryDate)} ===`,
        "", "", "", "", "", "", "", "", "",
      ]);
      continue;
    }
    // Skip placeholder drafts in the backup — they're empty rows the user
    // hasn't filled yet
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
  // Reasonable column widths so the file opens cleanly in Excel/Sheets
  ws["!cols"] = [
    { wch: 8 },
    { wch: 22 },
    { wch: 16 },
    { wch: 24 },
    { wch: 22 },
    { wch: 24 },
    { wch: 18 },
    { wch: 14 },
    { wch: 12 },
    { wch: 10 },
    { wch: 22 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, creator.name.slice(0, 28) || "Sheet");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const filename = `${creator.slug}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
