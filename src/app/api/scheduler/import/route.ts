import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import * as XLSX from "xlsx";

export const dynamic = "force-dynamic";

interface XLSXRow {
  [key: string]: string | number | undefined;
}

// Excel date serial number → JS Date
function excelDateToJsDate(serial: number): Date {
  // Excel epoch is 1900-01-01, JS epoch is 1970-01-01
  // Excel has a leap year bug (treats 1900 as leap year)
  const utcDays = Math.floor(serial - 25569);
  const utcMs = utcDays * 86400 * 1000;
  return new Date(utcMs);
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const replaceMode = formData.get("replace") === "true";
    
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    
    const buffer = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buffer, { type: "buffer" });
    
    type ParsedRow = { username: string; category: string; expiryDate: Date | null; note: string };
    const allRows: ParsedRow[] = [];
    
    // Process each sheet (Odličan, Dobar, Uzasni, Svi (Sortirano), Sheet1)
    const targetSheets = wb.SheetNames.filter((name) => 
      !name.toLowerCase().includes("pregled")
    );
    
    for (const sheetName of targetSheets) {
      const sheet = wb.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json<XLSXRow>(sheet, { 
        header: ["br", "username", "category", "expiryDate", "day", "daysLeft", "status", "note"],
        defval: "",
        range: 2, // skip header rows
      });
      
      for (const row of data) {
        const username = String(row.username || "").trim();
        if (!username) continue;
        
        // Clean username (remove extra text after spaces, like "URADITI APPEAL")
        const cleanUsername = username.split(/\s+/)[0].toLowerCase();
        if (!cleanUsername || cleanUsername.length < 2) continue;
        
        const category = String(row.category || "").trim().toUpperCase();
        if (!["ODLIČAN", "DOBAR", "LOŠI", "SHADOWBANNED", "SREDNJI"].includes(category)) continue;
        
        let expiryDate: Date | null = null;
        if (typeof row.expiryDate === "number" && row.expiryDate > 0) {
          expiryDate = excelDateToJsDate(row.expiryDate);
        }
        
        const note = String(row.note || "").trim();
        
        allRows.push({ username: cleanUsername, category, expiryDate, note });
      }
    }
    
    // Deduplicate by username — prefer entries WITH a date over those without,
    // since some sheets (like "Svi (Sortirano)") include duplicate rows that may
    // have empty date fields and would otherwise clobber good data.
    const uniqueMap = new Map<string, ParsedRow>();
    for (const row of allRows) {
      const existing = uniqueMap.get(row.username);
      if (!existing) {
        uniqueMap.set(row.username, row);
        continue;
      }
      // Prefer the row that has a date
      if (!existing.expiryDate && row.expiryDate) {
        uniqueMap.set(row.username, row);
      } else if (existing.expiryDate && !row.expiryDate) {
        // keep existing
      } else if (row.note && !existing.note) {
        // both have/don't have date equally — prefer one with note
        uniqueMap.set(row.username, row);
      }
    }
    const uniqueRows = Array.from(uniqueMap.values());
    
    if (replaceMode) {
      await prisma.scheduleEntry.deleteMany({});
    }
    
    let imported = 0;
    let updated = 0;
    
    for (const row of uniqueRows) {
      const result = await prisma.scheduleEntry.upsert({
        where: { username: row.username },
        update: {
          category: row.category,
          expiryDate: row.expiryDate,
          note: row.note || null,
        },
        create: {
          username: row.username,
          category: row.category,
          expiryDate: row.expiryDate,
          note: row.note || null,
        },
      });
      // upsert doesn't tell us if created or updated, so check createdAt vs updatedAt
      if (result.createdAt.getTime() === result.updatedAt.getTime()) imported++;
      else updated++;
    }
    
    return NextResponse.json({
      success: true,
      total: uniqueRows.length,
      imported,
      updated,
      sheets: targetSheets,
    });
  } catch (error) {
    console.error("Scheduler import error:", error);
    return NextResponse.json({ 
      error: "Failed to import", 
      message: error instanceof Error ? error.message : String(error) 
    }, { status: 500 });
  }
}
