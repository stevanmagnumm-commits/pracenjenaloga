import { promises as fs } from "fs";
import path from "path";
import * as XLSX from "xlsx";
import { stateDir } from "./run-state";
import { VIEW_BUCKET_ORDER, VIEW_BUCKET_LABEL, type ViewBucket } from "./view-buckets";
import type { ViewsCheckResult } from "./ig-views-check";

/**
 * Every finished Views Checker run, kept on disk as an Excel file.
 *
 * The run's results otherwise live only in memory, and the next run - anyone's
 * - replaces them. On 2026-11-27 a colleague started a run after a 1,795-account
 * one and that was the end of it: what could be pieced back together came from
 * the reel cache and the log, two thirds of the accounts at best and with the
 * wrong window. A file written the moment a run ends costs nothing and makes
 * that impossible.
 *
 * Written for stopped and partial runs too: half a run is still half the work.
 */

const DIR = () => path.join(stateDir(), "views-runs");

/** Runs kept. A 5,822-account run is about 1 MB compressed (2.5 MB without), so 100 stay near 100 MB. */
const KEEP = 100;

/** What a file name may look like - also the guard on the download route. */
export const RUN_FILE_RE = /^views-check_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-z]+_\d+(_prekinut)?\.xlsx$/;

export interface ArchivedRun {
  file: string;
  size: number;
  savedAt: number;
}

export interface RunMeta {
  mode: "accounts" | "reels";
  startedAt: number;
  total: number;
  completed: number;
  abortedReason: string | null;
}

/** Belgrade wall-clock parts, because that is the clock the team reads. */
function localParts(ms: number): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const out: Record<string, string> = {};
  for (const p of parts) out[p.type] = p.value;
  return out;
}

function localStamp(ms: number): string {
  const p = localParts(ms);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

const label = (b: ViewBucket) => VIEW_BUCKET_LABEL[b] ?? b;

function sortByGroup(rows: ViewsCheckResult[]): ViewsCheckResult[] {
  return [...rows].sort((a, b) => {
    const g = VIEW_BUCKET_ORDER.indexOf(a.bucket) - VIEW_BUCKET_ORDER.indexOf(b.bucket);
    if (g) return g;
    const v = (b.avgViews ?? -1) - (a.avgViews ?? -1);
    if (v) return v;
    return a.username.localeCompare(b.username);
  });
}

function rowSheet(rows: ViewsCheckResult[], reels: boolean): XLSX.WorkSheet {
  const head = reels
    ? ["Username", "Reel", "Pregledi", "Grupa", "Napomena"]
    : ["Username", "Grupa", "Prosek pregleda", "Rilova u proseku", "Prosek 6 najnovijih", "Rilova u 6", "Napomena"];
  const aoa: (string | number | null)[][] = [head];
  for (const r of rows) {
    aoa.push(
      reels
        ? [r.username, r.url ?? r.shortcode ?? "", r.avgViews, label(r.bucket), r.note ?? ""]
        : [
            r.username,
            label(r.bucket),
            r.avgViews,
            r.avgViews === null ? null : r.videosCounted,
            r.avgViews6 ?? null,
            r.avgViews6 == null ? null : r.videosCounted6 ?? null,
            r.note ?? "",
          ],
    );
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = reels
    ? [{ wch: 28 }, { wch: 46 }, { wch: 10 }, { wch: 16 }, { wch: 50 }]
    : [{ wch: 28 }, { wch: 16 }, { wch: 15 }, { wch: 15 }, { wch: 18 }, { wch: 10 }, { wch: 50 }];
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: head.length - 1 } }) };
  return ws;
}

/** Sheet names: Excel forbids some characters and caps the length at 31. */
const sheetName = (b: ViewBucket) =>
  label(b).replace(/[\\/?*[\]:]/g, "").replace("<", "ispod").replace(/[–·]/g, "-").replace(/\s+/g, " ").trim().slice(0, 31);

export function buildRunWorkbook(rows: ViewsCheckResult[], meta: RunMeta, finishedAt: number): XLSX.WorkBook {
  const sorted = sortByGroup(rows);
  const reels = meta.mode === "reels";
  const wb = XLSX.utils.book_new();

  const summary: (string | number)[][] = [
    ["Views Checker - " + (reels ? "reelovi" : "nalozi")],
    ["Pokrenut", localStamp(meta.startedAt)],
    ["Zavrsen", localStamp(finishedAt)],
    ["Provereno", `${meta.completed} od ${meta.total}`],
  ];
  if (meta.completed < meta.total) summary.push(["Stanje", "PREKINUT - nisu svi provereni"]);
  if (meta.abortedReason) summary.push(["Razlog", meta.abortedReason]);
  summary.push([], ["Grupa", "Broj"]);
  for (const b of VIEW_BUCKET_ORDER) {
    const n = sorted.filter((r) => r.bucket === b).length;
    if (n) summary.push([label(b), n]);
  }
  summary.push(["Ukupno", sorted.length]);
  const ws = XLSX.utils.aoa_to_sheet(summary);
  ws["!cols"] = [{ wch: 18 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws, "Pregled");

  XLSX.utils.book_append_sheet(wb, rowSheet(sorted, reels), "Po grupama");
  for (const b of VIEW_BUCKET_ORDER) {
    const part = sorted.filter((r) => r.bucket === b);
    if (part.length) XLSX.utils.book_append_sheet(wb, rowSheet(part, reels), sheetName(b));
  }
  return wb;
}

/** Write the run to disk. Never throws: losing the file must not break a run. */
export async function archiveViewsRun(rows: ViewsCheckResult[], meta: RunMeta): Promise<string | null> {
  if (!rows.length) return null;
  try {
    const finishedAt = Date.now();
    const p = localParts(finishedAt);
    const stopped = meta.completed < meta.total ? "_prekinut" : "";
    const file =
      `views-check_${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}_` +
      `${meta.mode === "reels" ? "reels" : "nalozi"}_${rows.length}${stopped}.xlsx`;
    const buf = XLSX.write(buildRunWorkbook(rows, meta, finishedAt), { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
    await fs.mkdir(DIR(), { recursive: true });
    const tmp = path.join(DIR(), file + ".tmp");
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, path.join(DIR(), file));
    console.log(`[ig-views-check] Saved ${rows.length} rows to views-runs/${file}`);
    await prune();
    return file;
  } catch (err) {
    console.error("[ig-views-check] could not save the run as Excel:", err);
    return null;
  }
}

export async function listArchivedRuns(): Promise<ArchivedRun[]> {
  try {
    const names = (await fs.readdir(DIR())).filter((n) => RUN_FILE_RE.test(n));
    const runs = await Promise.all(
      names.map(async (file) => {
        const st = await fs.stat(path.join(DIR(), file));
        return { file, size: st.size, savedAt: st.mtimeMs };
      }),
    );
    return runs.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export async function readArchivedRun(file: string): Promise<Buffer | null> {
  if (!RUN_FILE_RE.test(file)) return null;
  try {
    return await fs.readFile(path.join(DIR(), file));
  } catch {
    return null;
  }
}

async function prune(): Promise<void> {
  const runs = await listArchivedRuns();
  for (const r of runs.slice(KEEP)) {
    await fs.unlink(path.join(DIR(), r.file)).catch(() => {});
  }
}
