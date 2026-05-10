import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import * as XLSX from "xlsx";

export const dynamic = "force-dynamic";

const DAY_NAMES_SR = ["Ned", "Pon", "Uto", "Sre", "Čet", "Pet", "Sub"];

function jsDateToExcelSerial(d: Date): number {
  const utcMs = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor(utcMs / 86400000 + 25569);
}

function statusText(daysRemaining: number | null): string {
  if (daysRemaining === null) return "";
  if (daysRemaining < 0) return `ISTEKAO (pre ${Math.abs(daysRemaining)}d)`;
  if (daysRemaining === 0) return "DANAS";
  if (daysRemaining <= 3) return `Hitno (${daysRemaining}d)`;
  if (daysRemaining <= 7) return `Uskoro (${daysRemaining}d)`;
  return `U redu (${daysRemaining}d)`;
}

function calcDays(expiry: Date | null): number | null {
  if (!expiry) return null;
  const now = new Date();
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const e = new Date(expiry);
  const expiryMs = new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime();
  return Math.round((expiryMs - todayMs) / 86400000);
}

function priorityScore(category: string, daysRemaining: number | null): number {
  const catWeight: Record<string, number> = {
    "ODLIČAN": 0,
    "DOBAR": 100000,
    "LOŠI": 200000,
    "SREDNJI": 200000,
    "SHADOWBANNED": 300000,
  };
  const dayPart = daysRemaining === null ? 99999 : daysRemaining + 50000;
  return (catWeight[category] ?? 400000) + dayPart;
}

interface SheetRow {
  num: number | null;
  username: string;
  category: string;
  expirySerial: number | "";
  dayName: string;
  daysRemaining: number | "";
  status: string;
  note: string;
}

function buildSheet(title: string, rows: SheetRow[]): XLSX.WorkSheet {
  const aoa: (string | number | null)[][] = [
    [title],
    ["Br.", "Korisničko ime", "Kategorija", "Datum isteka", "Dan", "Dana preostalo", "Status", "Napomena"],
  ];
  for (const r of rows) {
    aoa.push([
      r.num,
      r.username,
      r.category,
      r.expirySerial === "" ? null : r.expirySerial,
      r.dayName,
      r.daysRemaining === "" ? null : r.daysRemaining,
      r.status,
      r.note,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  ws["!cols"] = [
    { wch: 5 },
    { wch: 28 },
    { wch: 14 },
    { wch: 13 },
    { wch: 6 },
    { wch: 14 },
    { wch: 22 },
    { wch: 28 },
  ];

  // Format the date column (D) cells as date type for Excel display.
  for (let i = 2; i < aoa.length; i++) {
    const cellRef = XLSX.utils.encode_cell({ r: i, c: 3 });
    if (ws[cellRef] && typeof ws[cellRef].v === "number") {
      ws[cellRef].t = "n";
      ws[cellRef].z = "dd.mm.yyyy";
    }
  }

  return ws;
}

export async function GET() {
  try {
    const entries = await prisma.scheduleEntry.findMany();

    const enriched = entries.map((e) => {
      const days = calcDays(e.expiryDate);
      return {
        username: e.username,
        category: e.category,
        expiryDate: e.expiryDate,
        note: e.note ?? "",
        daysRemaining: days,
        priority: priorityScore(e.category, days),
      };
    });

    const buildRows = (filtered: typeof enriched, numbered: boolean): SheetRow[] => {
      const sorted = [...filtered].sort((a, b) => {
        const ad = a.daysRemaining ?? 99999;
        const bd = b.daysRemaining ?? 99999;
        if (ad !== bd) return ad - bd;
        return a.username.localeCompare(b.username);
      });
      return sorted.map((e, idx) => ({
        num: numbered ? idx + 1 : null,
        username: e.username,
        category: e.category,
        expirySerial: e.expiryDate ? jsDateToExcelSerial(e.expiryDate) : "",
        dayName: e.expiryDate ? DAY_NAMES_SR[new Date(e.expiryDate).getDay()] : "",
        daysRemaining: e.daysRemaining ?? "",
        status: statusText(e.daysRemaining),
        note: e.note,
      }));
    };

    const odlican = enriched.filter((e) => e.category === "ODLIČAN");
    const dobar = enriched.filter((e) => e.category === "DOBAR");
    const losi = enriched.filter((e) => e.category === "LOŠI" || e.category === "SREDNJI");
    const shadowBanned = enriched.filter((e) => e.category === "SHADOWBANNED");

    const countWithDate = (arr: typeof enriched) => arr.filter((e) => e.expiryDate).length;
    const countWithoutDate = (arr: typeof enriched) => arr.filter((e) => !e.expiryDate).length;
    const countExpired = (arr: typeof enriched) =>
      arr.filter((e) => e.daysRemaining !== null && e.daysRemaining < 0).length;
    const countSoon = (arr: typeof enriched) =>
      arr.filter((e) => e.daysRemaining !== null && e.daysRemaining >= 0 && e.daysRemaining <= 7).length;

    const wb = XLSX.utils.book_new();

    const today = new Date();
    const todayStr = today.toLocaleDateString("sr-RS", { day: "2-digit", month: "2-digit", year: "numeric" });
    const pregledAoa: (string | number)[][] = [
      ["Pregled IG naloga"],
      [`Generisano ${todayStr}  •  Ukupno naloga: ${entries.length}`],
      [],
      ["Kategorija", "Ukupno", "Sa datumom", "Bez datuma", "Istekli", "≤ 7 dana"],
      ["ODLIČAN", odlican.length, countWithDate(odlican), countWithoutDate(odlican), countExpired(odlican), countSoon(odlican)],
      ["DOBAR", dobar.length, countWithDate(dobar), countWithoutDate(dobar), countExpired(dobar), countSoon(dobar)],
      ["LOŠI", losi.length, countWithDate(losi), countWithoutDate(losi), countExpired(losi), countSoon(losi)],
      ["SHADOWBANNED", shadowBanned.length, countWithDate(shadowBanned), countWithoutDate(shadowBanned), countExpired(shadowBanned), countSoon(shadowBanned)],
    ];
    const pregledWs = XLSX.utils.aoa_to_sheet(pregledAoa);
    pregledWs["!cols"] = [{ wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, pregledWs, "Pregled");

    XLSX.utils.book_append_sheet(
      wb,
      buildSheet(`ODLIČAN — ${odlican.length} naloga`, buildRows(odlican, true)),
      "Odličan"
    );
    XLSX.utils.book_append_sheet(
      wb,
      buildSheet(`DOBAR — ${dobar.length} naloga`, buildRows(dobar, true)),
      "Dobar"
    );
    XLSX.utils.book_append_sheet(
      wb,
      buildSheet(`LOŠI — ${losi.length} naloga`, buildRows(losi, true)),
      "Loši"
    );
    XLSX.utils.book_append_sheet(
      wb,
      buildSheet(`SHADOWBANNED — ${shadowBanned.length} naloga`, buildRows(shadowBanned, true)),
      "ShadowBanned"
    );

    const allSorted = [...enriched].sort((a, b) => a.priority - b.priority);
    const allRows: SheetRow[] = allSorted.map((e, idx) => ({
      num: idx + 1,
      username: e.username,
      category: e.category,
      expirySerial: e.expiryDate ? jsDateToExcelSerial(e.expiryDate) : "",
      dayName: e.expiryDate ? DAY_NAMES_SR[new Date(e.expiryDate).getDay()] : "",
      daysRemaining: e.daysRemaining ?? "",
      status: statusText(e.daysRemaining),
      note: e.note,
    }));
    XLSX.utils.book_append_sheet(
      wb,
      buildSheet("Svi nalozi — sortirano po prioritetu i datumu isteka", allRows),
      "Svi (Sortirano)"
    );

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const filename = `Chloe_IG_Nalozi_${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}.xlsx`;

    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Scheduler export error:", error);
    return NextResponse.json(
      { error: "Failed to export", message: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
