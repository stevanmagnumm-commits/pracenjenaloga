"use client";

import { useEffect, useState } from "react";
import { FileSpreadsheet } from "lucide-react";

interface ArchivedRun {
  file: string;
  size: number;
  savedAt: number;
}

/** "views-check_2026-11-27_10-18-50_nalozi_1795.xlsx" -> readable parts. */
function describe(file: string) {
  const m = file.match(/^views-check_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-\d{2}_([a-z]+)_(\d+)(_prekinut)?\.xlsx$/);
  if (!m) return { when: file, what: "", stopped: false };
  return {
    when: `${m[3]}.${m[2]}. ${m[4]}:${m[5]}`,
    what: `${Number(m[7]).toLocaleString("en-US")} ${m[6] === "reels" ? "reels" : "accounts"}`,
    stopped: Boolean(m[8]),
  };
}

const SHOWN = 10;

/**
 * Every finished run is saved on the server as an Excel file, sorted by group,
 * so starting a new check never throws the last one away.
 */
export function SavedRuns({ running }: { running: boolean }) {
  const [runs, setRuns] = useState<ArchivedRun[]>([]);
  const [all, setAll] = useState(false);

  // Fetched on load and again each time a run ends, which is when a file appears.
  useEffect(() => {
    if (running) return;
    let gone = false;
    fetch("/api/ig-views-check/runs", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!gone) setRuns(d.runs ?? []);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [running]);

  if (!runs.length) return null;
  const list = all ? runs : runs.slice(0, SHOWN);

  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm font-medium">Saved runs</p>
      <p className="text-xs text-muted-foreground mt-0.5">
        Every run is saved as Excel when it ends, sorted by group, so a new check does not lose the last one.
      </p>
      <ul className="mt-3 space-y-1.5">
        {list.map((r) => {
          const d = describe(r.file);
          return (
            <li key={r.file} className="flex items-center gap-2 text-sm">
              <FileSpreadsheet className="size-4 text-emerald-500 shrink-0" />
              <a
                href={`/api/ig-views-check/runs/${encodeURIComponent(r.file)}`}
                className="hover:underline"
                download
              >
                {d.when}
              </a>
              <span className="text-muted-foreground">· {d.what}</span>
              {d.stopped && <span className="text-xs text-amber-400">stopped early</span>}
            </li>
          );
        })}
      </ul>
      {runs.length > SHOWN && (
        <button className="mt-2 text-xs text-muted-foreground hover:underline" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${runs.length}`}
        </button>
      )}
    </div>
  );
}
