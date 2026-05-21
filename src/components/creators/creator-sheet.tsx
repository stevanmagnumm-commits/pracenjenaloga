"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Plus, Loader2, UserPlus, AlertTriangle, CheckCircle2, ArrowLeft, Copy, Trash2, Rows3, CalendarPlus, X, Download } from "lucide-react";

interface Creator {
  id: string;
  name: string;
  slug: string;
}

interface Row {
  id: string;
  kind: "account" | "separator";
  username: string;
  password: string | null;
  twoFa: string | null;
  proxy: string | null;
  notes: string | null;
  snapAccount: string | null;
  scheduledBy: string | null;
  scheduledAt: string | null;
  postsLeft: number | null;
  expiryDate: string | null;
  inTracker: boolean;
  trackerStatus: string | null;
  inScheduler: boolean;
  scheduleCategory: string | null;
  scheduleExpiryDate: string | null;
}

interface AddProgress {
  total: number;
  completed: number;
  current: string | null;
  successes: string[];
  errors: Array<{ username: string; error: string }>;
  running: boolean;
}

type Field = "username" | "password" | "twoFa" | "proxy" | "notes" | "snapAccount" | "scheduledBy" | "expiryDate";

interface ColumnDef {
  key: Field;
  label: string;
  width: number;
  type?: "text" | "date" | "select";
  options?: readonly string[];
}

const SCHEDULER_OPTIONS = ["Vuk", "Jocke", "Mike"] as const;

const COLUMNS: ColumnDef[] = [
  { key: "username", label: "Username", width: 180 },
  { key: "password", label: "Password", width: 130 },
  { key: "twoFa", label: "2FA", width: 160 },
  { key: "proxy", label: "Proxy", width: 180 },
  { key: "notes", label: "Notes", width: 160 },
  { key: "snapAccount", label: "Snap", width: 140 },
  { key: "scheduledBy", label: "Scheduled By", width: 130, type: "select", options: SCHEDULER_OPTIONS },
  { key: "expiryDate", label: "Expires", width: 140, type: "date" },
];

// Normalize loose date input ("01.06.26", "01/06/2026", "2026-06-01") to YYYY-MM-DD.
function normalizeDateInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return trimmed;
  const eu = trimmed.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (eu) {
    const day = eu[1].padStart(2, "0");
    const month = eu[2].padStart(2, "0");
    let year = eu[3];
    if (year.length === 2) year = "20" + year;
    return `${year}-${month}-${day}`;
  }
  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

// YYYY-MM-DD for native <input type="date"> binding.
function toDateInputValue(d: string | null | undefined): string {
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 10);
}

// Empty row marker used for the always-appended bottom row.
// When user starts typing into it, a real row is created server-side.
const NEW_ROW_ID = "__new__";

function emptyRow(): Row {
  return {
    id: NEW_ROW_ID,
    kind: "account",
    username: "",
    password: null,
    twoFa: null,
    proxy: null,
    notes: null,
    snapAccount: null,
    scheduledBy: null,
    scheduledAt: null,
    postsLeft: null,
    expiryDate: null,
    inTracker: false,
    trackerStatus: null,
    inScheduler: false,
    scheduleCategory: null,
    scheduleExpiryDate: null,
  };
}

interface PreviewRow {
  id: string;
  username: string;
  scheduledBy: string | null;
  expiryDate: string | null;
  postsLeft: number | null;
  alreadyInTracker: boolean;
  skipReason?: "draft" | "separator" | "no-username";
}

interface PreviewData {
  total: number;
  rows: PreviewRow[];
  importable: number;
  alreadyInTracker: number;
  alreadyInTrackerUsernames: string[];
  skipped: number;
  bySchedulerBy: Record<string, number>;
  withExpiry: number;
  withoutExpiry: number;
}

export function CreatorSheet({ slug, role }: { slug: string; role: "admin" | "creator" }) {
  const isAdmin = role === "admin";
  const [creator, setCreator] = useState<Creator | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastSelected = useRef<string | null>(null);

  // Pending edits keyed by `${rowId}.${field}` for in-flight PATCH calls.
  // We use this only to debounce server saves; visual state lives in `rows`.
  const pendingSavesRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Draft for the sentinel new row — promoted to a real server row when the
  // user blurs out of the sentinel row (or hits Enter from username).
  const newRowDraftRef = useRef<Record<string, string>>({});
  const sentinelRowRef = useRef<HTMLTableRowElement | null>(null);

  // Add-to-tracker confirmation dialog state. The dialog now shows a preview
  // (dedup counts + per-row values from the sheet) and the user just clicks
  // "Confirm" — there are no inputs to fill since scheduledBy / posts-left
  // come from the row data on the sheet.
  const [showAdd, setShowAdd] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [addProgress, setAddProgress] = useState<AddProgress | null>(null);
  const addPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Delete confirmation dialog state
  const [showDelete, setShowDelete] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const cRes = await fetch(`/api/creators/by-slug/${slug}`, { cache: "no-store" });
    if (cRes.status === 404) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    const c: Creator = await cRes.json();
    setCreator(c);

    const aRes = await fetch(`/api/creators/accounts?creatorId=${c.id}`, { cache: "no-store" });
    const accounts: Row[] = await aRes.json();
    setRows([...accounts, emptyRow()]);
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // How many blank rows to append when the user clicks the "+N rows" button.
  const [addRowsCount, setAddRowsCount] = useState<string>("10");

  // Cell-level update. For existing rows, debounces a PATCH; for the
  // sentinel new-row, just records the value locally — promotion to a real
  // server row happens on blur (Tab/Enter/click out of the sentinel row).
  function updateCell(rowId: string, field: Field, value: string) {
    if (rowId === NEW_ROW_ID) {
      setRows((prev) => prev.map((r) => (r.id === NEW_ROW_ID ? { ...r, [field]: value } : r)));
      newRowDraftRef.current[field] = value;
      return;
    }

    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, [field]: value } : r)));

    const key = `${rowId}.${field}`;
    const existing = pendingSavesRef.current.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      // Normalize loose date strings before sending so server stores a real date.
      const payloadValue = field === "expiryDate" ? normalizeDateInput(value) : value;
      await fetch(`/api/creators/accounts?id=${rowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: payloadValue }),
      }).catch(() => {});
      pendingSavesRef.current.delete(key);
    }, 500);
    pendingSavesRef.current.set(key, t);
  }

  // Append N blank rows directly to the DB. Each row gets a __draft_ placeholder
  // username that the user overwrites via inline edit.
  async function addBlankRows(count: number) {
    if (!creator || count < 1) return;
    const accountsToCreate = Array.from({ length: count }, () => ({ username: "" }));
    await fetch("/api/creators/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creatorId: creator.id, accounts: accountsToCreate }),
    });
    const r = await fetch(`/api/creators/accounts?creatorId=${creator.id}`, { cache: "no-store" });
    setRows([...(await r.json()), emptyRow()]);
  }

  // Insert a visual "NEW DAY" divider row at the bottom. Just a date — no
  // label / notes (the user explicitly asked to keep it minimal).
  async function addSeparator() {
    if (!creator) return;
    const today = new Date().toISOString().slice(0, 10);
    await fetch("/api/creators/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creatorId: creator.id,
        kind: "separator",
        expiryDate: today,
      }),
    });
    const r = await fetch(`/api/creators/accounts?creatorId=${creator.id}`, { cache: "no-store" });
    setRows([...(await r.json()), emptyRow()]);
  }

  async function promoteNewRow() {
    if (!creator) return;
    const draft = newRowDraftRef.current;
    const hasAny = Object.values(draft).some((v) => v && v.trim());
    if (!hasAny) return;

    // Snapshot + reset draft so subsequent keystrokes feed a fresh sentinel
    const snapshot = { ...draft };
    newRowDraftRef.current = {};

    const payload: Record<string, string> = {
      creatorId: creator.id,
      username: (snapshot.username || `acc_${Date.now()}`).trim(),
    };
    for (const f of ["password", "twoFa", "proxy", "notes", "snapAccount", "scheduledBy"] as const) {
      if (snapshot[f]) payload[f] = snapshot[f];
    }
    if (snapshot.expiryDate) {
      const norm = normalizeDateInput(snapshot.expiryDate);
      if (norm) payload.expiryDate = norm;
    }

    const res = await fetch("/api/creators/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || "Failed to create row");
      return;
    }
    const created: Row = await res.json();
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.id === NEW_ROW_ID);
      const newReal: Row = {
        ...created,
        inTracker: false,
        trackerStatus: null,
        inScheduler: false,
        scheduleCategory: null,
        scheduleExpiryDate: null,
      };
      if (idx === -1) return [...prev, newReal, emptyRow()];
      const next = prev.slice();
      next[idx] = newReal;
      next.push(emptyRow());
      return next;
    });
  }

  // Fire when any cell in the sentinel row loses focus. If the new focus
  // landed outside the sentinel row, promote it to a real account.
  function handleSentinelBlur() {
    setTimeout(() => {
      const active = document.activeElement;
      if (
        sentinelRowRef.current &&
        active instanceof HTMLElement &&
        sentinelRowRef.current.contains(active)
      ) {
        return;
      }
      const hasAny = Object.values(newRowDraftRef.current).some((v) => v && v.trim());
      if (hasAny) promoteNewRow();
    }, 0);
  }

  // Tab / Enter / arrow key navigation across cells.
  // Tab from the last cell of the sentinel row (or any movement that would
  // leave it) triggers a synchronous promote so the row materializes.
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>, rowIdx: number, colIdx: number) {
    const total = rows.length;
    const cols = COLUMNS.length;
    const isSentinel = rows[rowIdx]?.id === NEW_ROW_ID;
    let targetRow = rowIdx;
    let targetCol = colIdx;

    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        targetCol -= 1;
        if (targetCol < 0) {
          targetCol = cols - 1;
          targetRow -= 1;
        }
      } else {
        targetCol += 1;
        if (targetCol >= cols) {
          targetCol = 0;
          targetRow += 1;
        }
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      targetRow += e.shiftKey ? -1 : 1;
      // Enter from sentinel row should commit + advance to a fresh sentinel below
      if (isSentinel && !e.shiftKey) {
        const hasAny = Object.values(newRowDraftRef.current).some((v) => v && v.trim());
        if (hasAny) {
          promoteNewRow().then(() => {
            requestAnimationFrame(() => {
              const next = document.querySelector<HTMLInputElement>(
                `[data-cell="${rowIdx + 1}-${colIdx}"]`,
              );
              if (next) {
                next.focus();
                next.select();
              }
            });
          });
          return;
        }
      }
    } else if (e.key === "ArrowDown" && !e.altKey) {
      targetRow += 1;
    } else if (e.key === "ArrowUp" && !e.altKey) {
      targetRow -= 1;
    } else {
      return;
    }

    // If Tab would leave the sentinel row past its last column, promote first
    if (isSentinel && !e.shiftKey && e.key === "Tab" && targetRow > rowIdx) {
      const hasAny = Object.values(newRowDraftRef.current).some((v) => v && v.trim());
      if (hasAny) {
        promoteNewRow().then(() => {
          requestAnimationFrame(() => {
            const next = document.querySelector<HTMLInputElement>(
              `[data-cell="${targetRow}-${targetCol}"]`,
            );
            if (next) {
              next.focus();
              next.select();
            }
          });
        });
        return;
      }
    }

    if (targetRow < 0 || targetRow >= total || targetCol < 0 || targetCol >= cols) return;
    const next = document.querySelector<HTMLInputElement>(
      `[data-cell="${targetRow}-${targetCol}"]`
    );
    if (next) {
      next.focus();
      next.select();
    }
  }

  // Paste a tab/newline-delimited block starting at the current cell — exactly
  // like pasting a range out of Google Sheets / Excel.
  async function handlePaste(
    e: React.ClipboardEvent<HTMLInputElement>,
    rowIdx: number,
    colIdx: number,
  ) {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return; // single value — let default paste happen
    e.preventDefault();
    if (!creator) return;

    const pasteRows = text.replace(/\r/g, "").split("\n").map((line) => line.split("\t"));
    // Drop any all-empty trailing rows (common when copying a range with trailing newline)
    while (pasteRows.length > 0 && pasteRows[pasteRows.length - 1].every((c) => !c.trim())) {
      pasteRows.pop();
    }
    if (pasteRows.length === 0) return;

    // Snapshot current rows once — we'll build the full update list and POST/PATCH
    // each in parallel without re-rendering between, then bulk update state at the end.
    const updates: Array<{ rowId: string | null; field: Field; value: string; rowIdx: number; colIdx: number }> = [];
    for (let r = 0; r < pasteRows.length; r++) {
      const targetRowIdx = rowIdx + r;
      const targetRow = rows[targetRowIdx];
      const rowId = targetRow?.id ?? null;
      for (let c = 0; c < pasteRows[r].length; c++) {
        const targetColIdx = colIdx + c;
        if (targetColIdx >= COLUMNS.length) break;
        const field = COLUMNS[targetColIdx].key;
        const value = pasteRows[r][c];
        updates.push({ rowId, field, value, rowIdx: targetRowIdx, colIdx: targetColIdx });
      }
    }

    // Determine how many new rows need to be created
    const realRowCount = rows.filter((r) => r.id !== NEW_ROW_ID).length;
    const lastTargetIdx = rowIdx + pasteRows.length - 1;
    const newRowsNeeded = Math.max(0, lastTargetIdx - (realRowCount - 1));

    // Optimistic: apply visual update immediately to existing rows + sentinel
    setRows((prev) => {
      const next = prev.slice();
      for (const u of updates) {
        if (u.rowIdx < next.length) {
          next[u.rowIdx] = { ...next[u.rowIdx], [u.field]: u.value };
        }
      }
      return next;
    });

    // For new rows being created, collect their {field: value} bundles and POST as bulk
    if (newRowsNeeded > 0) {
      const accountsToCreate: Array<{ [k: string]: string }> = [];
      for (let r = realRowCount; r < realRowCount + newRowsNeeded; r++) {
        const idxInPaste = r - rowIdx;
        if (idxInPaste < 0 || idxInPaste >= pasteRows.length) continue;
        const cells = pasteRows[idxInPaste];
        const account: { [k: string]: string } = {};
        for (let c = 0; c < cells.length; c++) {
          const targetColIdx = colIdx + c;
          if (targetColIdx >= COLUMNS.length) break;
          const field = COLUMNS[targetColIdx].key;
          account[field] = cells[c];
        }
        if (!account.username) account.username = `acc_${Date.now()}_${r}`;
        accountsToCreate.push(account);
      }
      if (accountsToCreate.length > 0) {
        await fetch("/api/creators/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ creatorId: creator.id, accounts: accountsToCreate }),
        }).catch(() => {});
      }
    }

    // PATCH existing rows
    const patches = updates.filter((u) => u.rowId && u.rowId !== NEW_ROW_ID);
    const grouped = new Map<string, Record<string, string>>();
    for (const p of patches) {
      const g = grouped.get(p.rowId!) || {};
      g[p.field] = p.value;
      grouped.set(p.rowId!, g);
    }
    await Promise.all(
      Array.from(grouped.entries()).map(([id, data]) =>
        fetch(`/api/creators/accounts?id=${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }).catch(() => {})
      )
    );

    // Re-fetch to sync state (new IDs, server defaults, etc.)
    if (creator) {
      const r = await fetch(`/api/creators/accounts?creatorId=${creator.id}`, { cache: "no-store" });
      const accounts: Row[] = await r.json();
      setRows([...accounts, emptyRow()]);
    }
  }

  function isSelectable(r: Row) {
    return r.id !== NEW_ROW_ID && r.kind !== "separator";
  }

  function toggleSelect(id: string, shiftKey: boolean) {
    const row = rows.find((r) => r.id === id);
    if (!row || !isSelectable(row)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastSelected.current && lastSelected.current !== id) {
        const ids = rows.filter(isSelectable).map((r) => r.id);
        const from = ids.indexOf(lastSelected.current);
        const to = ids.indexOf(id);
        if (from !== -1 && to !== -1) {
          const [start, end] = from < to ? [from, to] : [to, from];
          const add = !prev.has(id);
          for (let i = start; i <= end; i++) {
            if (add) next.add(ids[i]);
            else next.delete(ids[i]);
          }
        }
      } else {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      lastSelected.current = id;
      return next;
    });
  }

  function toggleSelectAll() {
    const realIds = rows.filter(isSelectable).map((r) => r.id);
    if (selected.size === realIds.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(realIds));
    }
  }

  function stopAddPolling() {
    if (addPollRef.current) {
      clearInterval(addPollRef.current);
      addPollRef.current = null;
    }
  }
  useEffect(() => stopAddPolling, []);

  async function pollAdd() {
    const res = await fetch("/api/creators/accounts/add-to-tracker", { cache: "no-store" });
    if (!res.ok) return;
    const data: AddProgress = await res.json();
    setAddProgress(data);
    if (!data.running) {
      stopAddPolling();
      if (creator) {
        const r = await fetch(`/api/creators/accounts?creatorId=${creator.id}`, { cache: "no-store" });
        setRows([...(await r.json()), emptyRow()]);
      }
    }
  }

  // Fetch the preview (dedup stats + per-row data) before showing the dialog.
  async function openAdd() {
    if (selected.size === 0) return;
    setShowAdd(true);
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/creators/accounts/add-to-tracker/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "Failed to load preview");
        setShowAdd(false);
        return;
      }
      setPreview(await res.json());
    } finally {
      setPreviewLoading(false);
    }
  }

  async function startAdd() {
    if (selected.size === 0 || !preview || preview.importable === 0) return;
    const res = await fetch("/api/creators/accounts/add-to-tracker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: Array.from(selected) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || "Failed to start");
      return;
    }
    setAddProgress({
      total: preview.importable,
      completed: 0,
      current: null,
      successes: [],
      errors: [],
      running: true,
    });
    stopAddPolling();
    addPollRef.current = setInterval(pollAdd, 2000);
  }

  // Remove a single row (used for the per-separator "×" delete button).
  async function deleteRow(id: string) {
    if (!creator || id === NEW_ROW_ID) return;
    await fetch(`/api/creators/accounts?id=${id}`, { method: "DELETE" });
    const r = await fetch(`/api/creators/accounts?creatorId=${creator.id}`, { cache: "no-store" });
    setRows([...(await r.json()), emptyRow()]);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function deleteSelected() {
    setShowDelete(false);
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    await fetch("/api/creators/accounts", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    setSelected(new Set());
    if (creator) {
      const r = await fetch(`/api/creators/accounts?creatorId=${creator.id}`, { cache: "no-store" });
      setRows([...(await r.json()), emptyRow()]);
    }
  }

  function copyUsernames() {
    const text = rows
      .filter((r) => selected.has(r.id))
      .map((r) => r.username)
      .join("\n");
    navigator.clipboard.writeText(text);
  }

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 text-gray-900">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Sheet not found</h1>
          <p className="mt-2 text-sm text-gray-600">The creator "{slug}" doesn't exist or has been deleted.</p>
        </div>
      </div>
    );
  }
  if (loading || !creator) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="size-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {/* Top bar */}
      <div className="border-b border-gray-200 bg-white px-6 py-3 shadow-sm">
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center gap-3">
          <a href="/creators" className="text-gray-500 hover:text-gray-700" title="Back to admin">
            <ArrowLeft className="size-4" />
          </a>
          <h1 className="text-lg font-semibold">{creator.name}'s sheet</h1>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
            {rows.filter(isSelectable).length} accounts
          </span>

          <div className="ml-4 flex items-center gap-1 border-l border-gray-200 pl-4">
            <input
              type="number"
              min={1}
              max={500}
              value={addRowsCount}
              onChange={(e) => setAddRowsCount(e.target.value)}
              className="w-14 rounded-md border border-gray-300 px-2 py-1 text-center text-xs focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={() => {
                const n = Number(addRowsCount);
                if (Number.isFinite(n) && n > 0) addBlankRows(Math.min(n, 500));
              }}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <Rows3 className="size-3.5" /> Add rows
            </button>

            <button
              onClick={addSeparator}
              className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
              title="Insert a 'NEW DAY' separator below the last row"
            >
              <CalendarPlus className="size-3.5" /> New day
            </button>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {isAdmin ? (
              <a
                href={`/api/creators/by-slug/${slug}/export`}
                className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                title="Download all rows as XLSX (manual backup)"
              >
                <Download className="size-3.5" /> Download XLSX
              </a>
            ) : (
              <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700">
                view-only
              </span>
            )}
            {selected.size > 0 && (
              <>
                <span className="text-sm text-gray-500">{selected.size} selected</span>
                <button
                  onClick={copyUsernames}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  <Copy className="size-3.5" /> Copy usernames
                </button>
                {isAdmin && (
                  <button
                    onClick={openAdd}
                    className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    <UserPlus className="size-3.5" /> Add to Tracker
                  </button>
                )}
                <button
                  onClick={() => setShowDelete(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="size-3.5" /> Delete
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Spreadsheet */}
      <div className="mx-auto max-w-screen-2xl overflow-auto p-4">
        <div className="inline-block min-w-full rounded-md border border-gray-300 bg-white shadow-sm">
          <table className="border-collapse">
            <thead>
              <tr className="sticky top-0 z-10 bg-gray-100">
                <th className="w-12 border-r border-b border-gray-300 bg-gray-100 px-1 text-center text-xs font-medium text-gray-600">
                  <input
                    type="checkbox"
                    checked={selected.size > 0 && selected.size === rows.filter((r) => r.id !== NEW_ROW_ID).length}
                    onChange={toggleSelectAll}
                    className="size-3.5 accent-blue-600"
                  />
                </th>
                <th className="w-10 border-r border-b border-gray-300 bg-gray-100 text-center text-xs font-medium text-gray-500">#</th>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    style={{ width: c.width, minWidth: c.width }}
                    className="border-r border-b border-gray-300 bg-gray-100 px-2 py-1.5 text-left text-xs font-semibold uppercase text-gray-700"
                  >
                    {c.label}
                  </th>
                ))}
                <th className="border-r border-b border-gray-300 bg-gray-100 px-2 py-1.5 text-left text-xs font-semibold uppercase text-gray-700" style={{ width: 140, minWidth: 140 }}>
                  Tracker
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => {
                // Visual "NEW DAY" divider — just a date, full-width pink row.
                if (row.kind === "separator") {
                  return (
                    <tr key={row.id + "-" + rowIdx} className="bg-rose-100">
                      <td className="w-12 border-r border-b border-rose-200" />
                      <td className="w-10 border-r border-b border-rose-200 text-center text-xs text-rose-400">
                        —
                      </td>
                      <td colSpan={COLUMNS.length + 1} className="border-b border-rose-200 p-0">
                        <div className="flex items-center gap-2 px-2 py-1.5">
                          <input
                            type="date"
                            value={toDateInputValue(row.expiryDate)}
                            onChange={(e) => updateCell(row.id, "expiryDate", e.target.value)}
                            className="w-36 rounded-sm border border-rose-200 bg-white px-1.5 py-0.5 text-xs font-medium text-rose-900 focus:border-rose-500 focus:outline-none"
                          />
                          <span className="text-xs font-semibold uppercase tracking-wider text-rose-600">— new day —</span>
                          <div className="flex-1" />
                          <button
                            onClick={() => deleteRow(row.id)}
                            className="rounded-sm p-0.5 text-rose-400 hover:bg-rose-200 hover:text-rose-700"
                            title="Remove this day separator"
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                <tr
                  key={row.id + "-" + rowIdx}
                  ref={row.id === NEW_ROW_ID ? sentinelRowRef : undefined}
                  className={`${selected.has(row.id) ? "bg-blue-50" : "hover:bg-gray-50/40"} ${row.id === NEW_ROW_ID ? "bg-amber-50/30" : ""}`}
                >
                  <td className="w-12 border-r border-b border-gray-200 text-center">
                    {row.id !== NEW_ROW_ID && (
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={(e) => toggleSelect(row.id, (e.nativeEvent as MouseEvent).shiftKey)}
                        className="size-3.5 accent-blue-600"
                      />
                    )}
                  </td>
                  <td className="w-10 border-r border-b border-gray-200 text-center text-xs text-gray-400">
                    {row.id === NEW_ROW_ID ? <Plus className="mx-auto size-3" /> : rowIdx + 1}
                  </td>
                  {COLUMNS.map((col, colIdx) => {
                    const raw = row[col.key];
                    const val = col.type === "date" ? toDateInputValue(raw as string | null) : (raw ?? "") as string;
                    return (
                      <td
                        key={col.key}
                        className="border-r border-b border-gray-200 p-0"
                        style={{ width: col.width, minWidth: col.width }}
                      >
                        {col.type === "select" ? (
                          <select
                            data-cell={`${rowIdx}-${colIdx}`}
                            value={val}
                            onChange={(e) => updateCell(row.id, col.key, e.target.value)}
                            onKeyDown={(e) => handleKeyDown(e as unknown as React.KeyboardEvent<HTMLInputElement>, rowIdx, colIdx)}
                            onBlur={row.id === NEW_ROW_ID ? handleSentinelBlur : undefined}
                            className="w-full appearance-none bg-transparent px-2 py-1.5 text-sm text-gray-900 outline-none focus:bg-blue-50 focus:ring-1 focus:ring-inset focus:ring-blue-500"
                          >
                            <option value="">—</option>
                            {col.options?.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                            {/* Preserve legacy values not in the new dropdown so they aren't silently dropped */}
                            {val && !col.options?.includes(val) && (
                              <option value={val}>{val}</option>
                            )}
                          </select>
                        ) : (
                          <input
                            type={col.type === "date" ? "date" : "text"}
                            data-cell={`${rowIdx}-${colIdx}`}
                            value={val}
                            onChange={(e) => updateCell(row.id, col.key, e.target.value)}
                            onKeyDown={(e) => handleKeyDown(e, rowIdx, colIdx)}
                            onPaste={(e) => handlePaste(e, rowIdx, colIdx)}
                            onBlur={row.id === NEW_ROW_ID ? handleSentinelBlur : undefined}
                            className="w-full bg-transparent px-2 py-1.5 text-sm text-gray-900 outline-none focus:bg-blue-50 focus:ring-1 focus:ring-inset focus:ring-blue-500"
                            placeholder={row.id === NEW_ROW_ID && colIdx === 0 ? "Start typing to add a new row…" : ""}
                          />
                        )}
                      </td>
                    );
                  })}
                  <td className="border-r border-b border-gray-200 px-2 py-1.5 text-xs">
                    {row.inTracker ? (
                      <div className="flex flex-col">
                        <span className="inline-flex items-center gap-1 text-green-600">
                          <CheckCircle2 className="size-3" /> In tracker
                        </span>
                        {row.scheduleCategory && (
                          <span className="text-[10px] text-gray-500">{row.scheduleCategory}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs text-gray-500">
          Type directly into any cell. Tab / Enter / arrow keys to move. Paste blocks straight from Google Sheets. The bottom amber row creates a new account as soon as you start typing.
        </p>
      </div>

      {/* Add to Tracker confirmation dialog */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !addProgress?.running) {
              setShowAdd(false);
              setAddProgress(null);
              setPreview(null);
            }
          }}
        >
          <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
            {!addProgress?.running && !addProgress?.total ? (
              <>
                <h2 className="text-lg font-semibold">Confirm import to Tracker</h2>
                <p className="mt-1 text-sm text-gray-600">
                  Each selected row will be imported, its Instagram data scraped, and a Scheduler entry created using the row's <b>Expires</b> date.
                </p>

                {previewLoading || !preview ? (
                  <div className="mt-6 flex items-center justify-center py-8 text-gray-400">
                    <Loader2 className="size-5 animate-spin" />
                  </div>
                ) : (
                  <div className="mt-4 space-y-3">
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-center">
                        <div className="text-2xl font-semibold text-green-700">{preview.importable}</div>
                        <div className="text-[10px] uppercase tracking-wider text-green-800">to import</div>
                      </div>
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-center">
                        <div className="text-2xl font-semibold text-amber-700">{preview.alreadyInTracker}</div>
                        <div className="text-[10px] uppercase tracking-wider text-amber-800">already in tracker</div>
                      </div>
                      <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-center">
                        <div className="text-2xl font-semibold text-gray-600">{preview.skipped}</div>
                        <div className="text-[10px] uppercase tracking-wider text-gray-700">empty / day rows</div>
                      </div>
                    </div>

                    {Object.keys(preview.bySchedulerBy).length > 0 && (
                      <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
                        <div className="text-[10px] uppercase tracking-wider text-gray-600">By scheduler</div>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs">
                          {Object.entries(preview.bySchedulerBy).map(([name, count]) => (
                            <span key={name} className="rounded-full bg-white px-2 py-0.5 font-medium text-gray-700 ring-1 ring-gray-200">
                              {name}: {count}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2">
                        <span className="font-semibold text-blue-800">{preview.withExpiry}</span>
                        <span className="ml-1 text-blue-700">with expiry → Scheduler</span>
                      </div>
                      <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-gray-600">
                        <span className="font-semibold">{preview.withoutExpiry}</span>
                        <span className="ml-1">no expiry → Tracker only</span>
                      </div>
                    </div>

                    {preview.alreadyInTracker > 0 && (
                      <details className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs">
                        <summary className="cursor-pointer text-amber-800">Show {preview.alreadyInTracker} duplicates (will be skipped)</summary>
                        <div className="mt-2 max-h-24 overflow-y-auto font-mono text-[11px] text-amber-900">
                          {preview.alreadyInTrackerUsernames.map((u) => (
                            <div key={u}>@{u}</div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}

                <div className="mt-5 flex justify-end gap-2">
                  <button
                    onClick={() => { setShowAdd(false); setPreview(null); }}
                    className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={startAdd}
                    disabled={!preview || preview.importable === 0}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Confirm import {preview ? `(${preview.importable})` : ""}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-lg font-semibold">
                  {addProgress.running ? "Importing…" : "Done"}
                </h2>
                <div className="mt-2 text-sm">
                  {addProgress.completed}/{addProgress.total}
                  {addProgress.current && <span className="ml-2 text-gray-500">@{addProgress.current}</span>}
                </div>
                <div className="mt-2 h-2 rounded-full bg-gray-200">
                  <div
                    className="h-2 rounded-full bg-blue-600 transition-all"
                    style={{ width: `${(addProgress.completed / addProgress.total) * 100}%` }}
                  />
                </div>
                {addProgress.errors.length > 0 && (
                  <div className="mt-3 max-h-32 overflow-y-auto rounded-md border border-red-200 bg-red-50 p-2 text-xs">
                    {addProgress.errors.map((e) => (
                      <div key={e.username} className="text-red-700">@{e.username}: {e.error}</div>
                    ))}
                  </div>
                )}
                {!addProgress.running && (
                  <div className="mt-4 flex justify-end">
                    <button
                      onClick={() => {
                        setShowAdd(false);
                        setAddProgress(null);
                        setPreview(null);
                        setSelected(new Set());
                      }}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Close
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {showDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => e.target === e.currentTarget && setShowDelete(false)}
        >
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              <h2 className="text-lg font-semibold">Delete {selected.size} rows?</h2>
            </div>
            <p className="mt-2 text-sm text-gray-600">
              This removes the rows from this sheet only. Tracker / Scheduler entries are NOT affected.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowDelete(false)}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={deleteSelected}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
