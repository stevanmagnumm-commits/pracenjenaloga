"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Upload, Download, ArrowUpDown, X, Loader2, Calendar, Copy, Check, Plus, Pencil, StickyNote, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber } from "@/lib/utils";

interface ScheduleEntry {
  id: string;
  username: string;
  category: string;
  expiryDate: string | null;
  note: string | null;
  daysRemaining: number | null;
  urgencyStatus: string;
  isTracked: boolean;
  status: string;
  videosTracked: number;
  avgLast36Views: number;
}

type SortField = "daysRemaining" | "category" | "username" | "avgLast36Views";

export function SchedulerPage() {
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string>("");
  const [sort, setSort] = useState<SortField>("daysRemaining");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [editingDateId, setEditingDateId] = useState<string | null>(null);
  const [editDateValue, setEditDateValue] = useState<string>("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editNoteValue, setEditNoteValue] = useState<string>("");
  const [editingPostsLeftId, setEditingPostsLeftId] = useState<string | null>(null);
  const [editPostsLeftValue, setEditPostsLeftValue] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addUsername, setAddUsername] = useState("");
  const [addCategory, setAddCategory] = useState<"ODLIČAN" | "DOBAR" | "LOŠI" | "SHADOWBANNED">("ODLIČAN");
  const [addExpiryDate, setAddExpiryDate] = useState("");
  const [addNote, setAddNote] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [groups, setGroups] = useState<{ id: string; name: string; memberCount: number }[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [includeUngrouped, setIncludeUngrouped] = useState(true);
  const [skipExisting, setSkipExisting] = useState(true);
  const [importingGroups, setImportingGroups] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/scheduler", { cache: "no-store" });
      if (res.ok) setEntries(await res.json());
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  // Auto-refresh: every 5 minutes, and whenever user returns to the tab.
  // This guarantees that "X days left" decrements without requiring a manual
  // page reload, even if the page stays open past midnight.
  useEffect(() => {
    const interval = setInterval(() => {
      fetchEntries();
    }, 5 * 60 * 1000);
    
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchEntries();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchEntries]);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const replace = confirm(
      "Replace all existing schedule entries with the file's contents?\n\n" +
      "OK = Replace (delete all current entries first)\n" +
      "Cancel = Merge (update existing, add new)"
    );

    setImporting(true);
    setImportResult("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("replace", String(replace));
      
      const res = await fetch("/api/scheduler/import", {
        method: "POST",
        body: formData,
      });
      
      const data = await res.json();
      if (res.ok) {
        setImportResult(
          `Imported ${data.total} entries (${data.imported} new, ${data.updated} updated) from sheets: ${data.sheets.join(", ")}`
        );
        fetchEntries();
      } else {
        setImportResult(`Error: ${data.error || data.message}`);
      }
    } catch (err) {
      setImportResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleUpdateDate(id: string, dateStr: string) {
    try {
      await fetch("/api/scheduler", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, expiryDate: dateStr || null }),
      });
      fetchEntries();
    } catch {}
    setEditingDateId(null);
    setEditDateValue("");
  }

  function startEditNote(entry: ScheduleEntry) {
    setEditingNoteId(entry.id);
    setEditNoteValue(entry.note || "");
  }

  async function saveNote(id: string) {
    try {
      await fetch("/api/scheduler", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, note: editNoteValue.trim() || null }),
      });
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, note: editNoteValue.trim() || null } : e))
      );
    } catch {}
    setEditingNoteId(null);
    setEditNoteValue("");
  }

  async function handleDelete(id: string, username: string) {
    if (!confirm(`Remove @${username} from scheduler?`)) return;
    try {
      await fetch(`/api/scheduler?id=${id}`, { method: "DELETE" });
      fetchEntries();
    } catch {}
  }

  async function openImportFromTracker() {
    try {
      const res = await fetch("/api/groups", { cache: "no-store" });
      if (res.ok) setGroups(await res.json());
    } catch {}
    setShowImportDialog(true);
  }

  async function handleImportFromTracker() {
    setImportingGroups(true);
    setImportResult("");
    try {
      const res = await fetch("/api/scheduler/import-from-tracker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupIds: Array.from(selectedGroupIds),
          includeUngrouped,
          skipExisting,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const parts = [
          `eligible: ${data.eligible}`,
          `added: ${data.added}`,
          `updated: ${data.updated}`,
          `skipped: ${data.skipped}`,
        ];
        const summary = data.summary
          ? ` · ODLIČAN ${data.summary.ODLIČAN}, DOBAR ${data.summary.DOBAR}, LOŠI ${data.summary.LOŠI}, SHADOWBANNED ${data.summary.SHADOWBANNED}`
          : "";
        setImportResult(`Imported from tracker — ${parts.join(", ")}${summary}`);
        setShowImportDialog(false);
        fetchEntries();
      } else {
        setImportResult(`Error: ${data.error || data.message}`);
      }
    } catch (err) {
      setImportResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImportingGroups(false);
    }
  }

  function toggleGroupSelection(id: string) {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleAddAccount() {
    if (!addUsername.trim()) return;
    setAddLoading(true);
    try {
      const res = await fetch("/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: addUsername.trim(),
          category: addCategory,
          expiryDate: addExpiryDate || null,
          note: addNote.trim() || null,
        }),
      });
      if (res.ok) {
        setAddUsername("");
        setAddCategory("ODLIČAN");
        setAddExpiryDate("");
        setAddNote("");
        setShowAddDialog(false);
        fetchEntries();
      } else {
        const data = await res.json();
        alert(`Error: ${data.error || "Failed to add"}`);
      }
    } catch {
      alert("Error adding account");
    } finally {
      setAddLoading(false);
    }
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(`Remove ${selectedIds.size} accounts from scheduler?`)) return;
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          fetch(`/api/scheduler?id=${id}`, { method: "DELETE" })
        )
      );
      setSelectedIds(new Set());
      fetchEntries();
    } catch {}
  }

  function startEditDate(entry: ScheduleEntry) {
    setEditingDateId(entry.id);
    if (entry.expiryDate) {
      const d = new Date(entry.expiryDate);
      setEditDateValue(d.toISOString().split("T")[0]);
    } else {
      setEditDateValue("");
    }
  }

  function startEditPostsLeft(entry: ScheduleEntry) {
    setEditingPostsLeftId(entry.id);
    setEditPostsLeftValue(entry.daysRemaining !== null ? String(entry.daysRemaining) : "");
  }

  async function savePostsLeft(id: string) {
    const n = parseInt(editPostsLeftValue, 10);
    if (isNaN(n)) {
      setEditingPostsLeftId(null);
      setEditPostsLeftValue("");
      return;
    }
    // expiryDate = today (local midnight) + n days
    const today = new Date();
    const expiry = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    expiry.setDate(expiry.getDate() + n);
    const yyyy = expiry.getFullYear();
    const mm = String(expiry.getMonth() + 1).padStart(2, "0");
    const dd = String(expiry.getDate()).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    try {
      await fetch("/api/scheduler", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, expiryDate: dateStr }),
      });
      fetchEntries();
    } catch {}
    setEditingPostsLeftId(null);
    setEditPostsLeftValue("");
  }

  function handleSort(field: SortField) {
    if (sort === field) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setDir(field === "daysRemaining" ? "asc" : "desc");
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === filteredEntries.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredEntries.map((e) => e.id)));
    }
  }

  function handleCopySelected() {
    const usernames = filteredEntries
      .filter((e) => selectedIds.has(e.id))
      .map((e) => e.username)
      .join("\n");
    navigator.clipboard.writeText(usernames);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Filter
  const filteredEntries = entries.filter((e) => {
    if (categoryFilter !== "all" && e.category !== categoryFilter) return false;
    return true;
  });

  // Sort
  const sortedEntries = [...filteredEntries].sort((a, b) => {
    let valA: number | string;
    let valB: number | string;
    
    switch (sort) {
      case "daysRemaining":
        valA = a.daysRemaining ?? 99999;
        valB = b.daysRemaining ?? 99999;
        break;
      case "category":
        const catOrder: Record<string, number> = { "ODLIČAN": 1, "DOBAR": 2, "LOŠI": 3, "SREDNJI": 3, "SHADOWBANNED": 4 };
        valA = catOrder[a.category] ?? 99;
        valB = catOrder[b.category] ?? 99;
        break;
      case "username":
        valA = a.username;
        valB = b.username;
        break;
      case "avgLast36Views":
        valA = a.avgLast36Views;
        valB = b.avgLast36Views;
        break;
    }
    
    if (typeof valA === "string" && typeof valB === "string") {
      return dir === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    return dir === "asc" ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
  });

  // Stats
  const stats = {
    total: entries.length,
    odlican: entries.filter((e) => e.category === "ODLIČAN").length,
    dobar: entries.filter((e) => e.category === "DOBAR").length,
    losi: entries.filter((e) => e.category === "LOŠI" || e.category === "SREDNJI").length,
    shadowBanned: entries.filter((e) => e.category === "SHADOWBANNED").length,
    expired: entries.filter((e) => e.urgencyStatus === "expired").length,
    urgent: entries.filter((e) => e.urgencyStatus === "today" || e.urgencyStatus === "urgent").length,
    soon: entries.filter((e) => e.urgencyStatus === "soon").length,
    noDate: entries.filter((e) => e.urgencyStatus === "no_date").length,
  };

  function SortableHeader({ field, children, className }: { field: SortField; children: React.ReactNode; className?: string }) {
    return (
      <TableHead className={className}>
        <button
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          onClick={() => handleSort(field)}
        >
          {children}
          <ArrowUpDown className={`size-3 ${sort === field ? "text-primary" : "text-muted-foreground/50"}`} />
        </button>
      </TableHead>
    );
  }

  function categoryBadge(category: string) {
    const colors: Record<string, string> = {
      "ODLIČAN": "bg-green-500/10 text-green-400",
      "DOBAR": "bg-yellow-500/10 text-yellow-400",
      "LOŠI": "bg-orange-500/10 text-orange-400",
      "SREDNJI": "bg-orange-500/10 text-orange-400",
      "SHADOWBANNED": "bg-purple-500/10 text-purple-400",
    };
    return (
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[category] || "bg-muted"}`}>
        {category}
      </span>
    );
  }

  function urgencyBadge(entry: ScheduleEntry) {
    if (entry.urgencyStatus === "no_date") {
      return <span className="text-xs text-muted-foreground">Bez datuma</span>;
    }
    
    const days = entry.daysRemaining!;
    if (days < 0) {
      return <span className="text-xs font-medium text-red-500">ISTEKAO ({Math.abs(days)}d)</span>;
    }
    if (days === 0) {
      return <span className="text-xs font-medium text-red-400">DANAS</span>;
    }
    if (days <= 3) {
      return <span className="text-xs font-medium text-orange-400">Hitno ({days}d)</span>;
    }
    if (days <= 7) {
      return <span className="text-xs font-medium text-yellow-400">Uskoro ({days}d)</span>;
    }
    return <span className="text-xs text-green-400">U redu ({days}d)</span>;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Scheduler</h1>
          <p className="text-sm text-muted-foreground">
            {entries.length} accounts · {stats.expired} expired · {stats.urgent} urgent · {stats.soon} soon
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={handleCopySelected}>
                {copied ? <Check className="mr-1.5 size-4 text-green-500" /> : <Copy className="mr-1.5 size-4" />}
                {copied ? "Copied!" : `Copy ${selectedIds.size}`}
              </Button>
              <Button variant="outline" size="sm" onClick={handleBulkDelete} className="text-red-500 hover:text-red-400 hover:bg-red-500/10">
                <X className="mr-1.5 size-4" />
                Remove {selectedIds.size}
              </Button>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileUpload}
            className="hidden"
          />
          <Button variant="outline" size="sm" onClick={() => setShowAddDialog(true)}>
            <Plus className="mr-1.5 size-4" />
            Add Account
          </Button>
          <Button variant="outline" size="sm" onClick={openImportFromTracker}>
            <Users className="mr-1.5 size-4" />
            Import from Tracker
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              window.location.href = "/api/scheduler/export";
            }}
            disabled={entries.length === 0}
          >
            <Download className="mr-1.5 size-4" />
            Download XLSX
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            {importing ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Upload className="mr-1.5 size-4" />}
            {importing ? "Importing..." : "Import XLSX"}
          </Button>
        </div>
      </div>

      {importResult && (
        <div className={`rounded-lg border p-3 text-sm ${importResult.startsWith("Error") ? "border-red-500/30 bg-red-500/10 text-red-400" : "border-green-500/30 bg-green-500/10 text-green-400"}`}>
          {importResult}
        </div>
      )}

      {/* Stats cards */}
      {entries.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">ODLIČAN</p>
            <p className="text-2xl font-bold text-green-400">{stats.odlican}</p>
            <p className="text-[10px] text-muted-foreground">800+ avg</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">DOBAR</p>
            <p className="text-2xl font-bold text-yellow-400">{stats.dobar}</p>
            <p className="text-[10px] text-muted-foreground">200-799 avg</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">LOŠI</p>
            <p className="text-2xl font-bold text-orange-400">{stats.losi}</p>
            <p className="text-[10px] text-muted-foreground">50-199 avg</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">SHADOWBANNED</p>
            <p className="text-2xl font-bold text-purple-400">{stats.shadowBanned}</p>
            <p className="text-[10px] text-muted-foreground">&lt;50 avg</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">No date</p>
            <p className="text-2xl font-bold text-muted-foreground">{stats.noDate}</p>
          </div>
        </div>
      )}

      {/* Filters */}
      {entries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground mr-1">Category:</span>
          {["all", "ODLIČAN", "DOBAR", "LOŠI", "SHADOWBANNED"].map((c) => (
            <button
              key={c}
              onClick={() => setCategoryFilter(c)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                categoryFilter === c ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {c === "all" ? "All" : c}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      {loading && entries.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center">
          <Calendar className="mx-auto size-12 text-muted-foreground/50" />
          <p className="mt-4 text-sm text-muted-foreground">No schedule entries yet</p>
          <p className="text-xs text-muted-foreground">Click &quot;Import XLSX&quot; to upload your schedule sheet</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 pl-4">
                  <input
                    type="checkbox"
                    checked={sortedEntries.length > 0 && selectedIds.size === sortedEntries.length}
                    onChange={toggleSelectAll}
                    className="size-4 rounded border-border accent-primary cursor-pointer"
                  />
                </TableHead>
                <SortableHeader field="username">Username</SortableHeader>
                <SortableHeader field="category">Category</SortableHeader>
                <TableHead>Expiry</TableHead>
                <TableHead>Posts left</TableHead>
                <SortableHeader field="daysRemaining">Status</SortableHeader>
                <SortableHeader field="avgLast36Views" className="text-right">Avg (last 36)</SortableHeader>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedEntries.map((entry) => (
                <TableRow key={entry.id} className={selectedIds.has(entry.id) ? "bg-primary/5" : ""}>
                  <TableCell className="pl-4">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(entry.id)}
                      onChange={() => toggleSelect(entry.id)}
                      className="size-4 rounded border-border accent-primary cursor-pointer"
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 flex-wrap">
                      <a
                        href={`https://www.instagram.com/${entry.username}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium hover:text-primary hover:underline"
                      >
                        @{entry.username}
                      </a>
                      {entry.status === "possibly_banned" && (
                        <span className="rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-500">Banned</span>
                      )}
                      {!entry.isTracked && (
                        <span className="rounded-full bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium text-orange-400">Untracked</span>
                      )}
                      {editingNoteId === entry.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            value={editNoteValue}
                            onChange={(e) => setEditNoteValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveNote(entry.id);
                              else if (e.key === "Escape") { setEditingNoteId(null); setEditNoteValue(""); }
                            }}
                            placeholder="Add note..."
                            className="rounded border border-border bg-background px-2 py-0.5 text-xs w-40 focus:outline-none focus:ring-1 focus:ring-primary/50"
                            autoFocus
                          />
                          <button
                            onClick={() => saveNote(entry.id)}
                            className="text-green-500 hover:text-green-400 text-xs"
                          >
                            ✓
                          </button>
                          <button
                            onClick={() => { setEditingNoteId(null); setEditNoteValue(""); }}
                            className="text-muted-foreground hover:text-foreground text-xs"
                          >
                            ✕
                          </button>
                        </div>
                      ) : entry.note ? (
                        <button
                          onClick={() => startEditNote(entry)}
                          className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 hover:bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-400 max-w-[200px]"
                          title="Click to edit"
                        >
                          <span className="truncate">{entry.note}</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => startEditNote(entry)}
                          className="inline-flex items-center gap-1 rounded-full border border-dashed border-border hover:border-amber-500/50 hover:text-amber-400 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors"
                          title="Add note"
                        >
                          <Pencil className="size-3" />
                          Note
                        </button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{categoryBadge(entry.category)}</TableCell>
                  <TableCell>
                    {editingDateId === entry.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="date"
                          value={editDateValue}
                          onChange={(e) => setEditDateValue(e.target.value)}
                          className="rounded border border-border bg-background px-2 py-1 text-xs"
                          autoFocus
                        />
                        <button
                          onClick={() => handleUpdateDate(entry.id, editDateValue)}
                          className="text-xs text-green-500 hover:text-green-400"
                        >
                          ✓
                        </button>
                        <button
                          onClick={() => setEditingDateId(null)}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startEditDate(entry)}
                        className="text-xs hover:text-primary"
                      >
                        {entry.expiryDate
                          ? new Date(entry.expiryDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
                          : "+ Set date"}
                      </button>
                    )}
                  </TableCell>
                  <TableCell>
                    {editingPostsLeftId === entry.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          value={editPostsLeftValue}
                          onChange={(e) => setEditPostsLeftValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") savePostsLeft(entry.id);
                            else if (e.key === "Escape") { setEditingPostsLeftId(null); setEditPostsLeftValue(""); }
                          }}
                          placeholder="e.g. 17"
                          className="w-20 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
                          autoFocus
                        />
                        <button
                          onClick={() => savePostsLeft(entry.id)}
                          className="text-xs text-green-500 hover:text-green-400"
                        >
                          ✓
                        </button>
                        <button
                          onClick={() => { setEditingPostsLeftId(null); setEditPostsLeftValue(""); }}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startEditPostsLeft(entry)}
                        className="text-xs hover:text-primary tabular-nums"
                        title="Click to set 'posts left' — date will be today + N days"
                      >
                        {entry.daysRemaining !== null ? `${entry.daysRemaining}` : <span className="text-muted-foreground">+ Set</span>}
                      </button>
                    )}
                  </TableCell>
                  <TableCell>{urgencyBadge(entry)}</TableCell>
                  <TableCell className="text-right font-medium">
                    {entry.isTracked ? formatNumber(entry.avgLast36Views) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(entry.id, entry.username)}
                    >
                      <X className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Import from Tracker Dialog */}
      {showImportDialog && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setShowImportDialog(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <h2 className="text-lg font-semibold">Import from Tracker</h2>
                <button onClick={() => setShowImportDialog(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="size-5" />
                </button>
              </div>
              <div className="p-5 space-y-4">
                <p className="text-xs text-muted-foreground">
                  Pick which tracker groups to import. Each account will be added to the scheduler with its category
                  computed from average views of its last 36 reels.
                </p>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer rounded-md border border-border px-3 py-2 hover:bg-muted">
                    <input
                      type="checkbox"
                      checked={includeUngrouped}
                      onChange={(e) => setIncludeUngrouped(e.target.checked)}
                      className="size-4 rounded border-border accent-primary"
                    />
                    <span className="text-sm font-medium">Ungrouped accounts</span>
                  </label>
                  {groups.map((g) => (
                    <label
                      key={g.id}
                      className="flex items-center justify-between gap-2 cursor-pointer rounded-md border border-border px-3 py-2 hover:bg-muted"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedGroupIds.has(g.id)}
                          onChange={() => toggleGroupSelection(g.id)}
                          className="size-4 rounded border-border accent-primary"
                        />
                        <span className="text-sm font-medium">{g.name}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{g.memberCount} accounts</span>
                    </label>
                  ))}
                </div>

                <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={skipExisting}
                    onChange={(e) => setSkipExisting(e.target.checked)}
                    className="size-3.5 rounded border-border accent-primary"
                  />
                  Skip accounts already in scheduler (uncheck to also re-categorize them)
                </label>

                <div className="flex gap-2 pt-2 border-t border-border">
                  <Button variant="outline" className="flex-1" onClick={() => setShowImportDialog(false)}>
                    Cancel
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={handleImportFromTracker}
                    disabled={importingGroups || (!includeUngrouped && selectedGroupIds.size === 0)}
                  >
                    {importingGroups ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Users className="mr-1.5 size-4" />}
                    Import
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Add Account Dialog */}
      {showAddDialog && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setShowAddDialog(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <h2 className="text-lg font-semibold">Add Account to Scheduler</h2>
                <button onClick={() => setShowAddDialog(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="size-5" />
                </button>
              </div>
              <div className="p-5 space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Username</label>
                  <input
                    value={addUsername}
                    onChange={(e) => setAddUsername(e.target.value)}
                    placeholder="username (without @)"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Category</label>
                  <select
                    value={addCategory}
                    onChange={(e) => setAddCategory(e.target.value as "ODLIČAN" | "DOBAR" | "LOŠI" | "SHADOWBANNED")}
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  >
                    <option value="ODLIČAN">ODLIČAN</option>
                    <option value="DOBAR">DOBAR</option>
                    <option value="LOŠI">LOŠI</option>
                    <option value="SHADOWBANNED">SHADOWBANNED</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Expiry Date (optional)</label>
                  <input
                    type="date"
                    value={addExpiryDate}
                    onChange={(e) => setAddExpiryDate(e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Note (optional)</label>
                  <input
                    value={addNote}
                    onChange={(e) => setAddNote(e.target.value)}
                    placeholder="Optional note"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div className="flex gap-2 pt-2 border-t border-border">
                  <Button variant="outline" className="flex-1" onClick={() => setShowAddDialog(false)}>
                    Cancel
                  </Button>
                  <Button className="flex-1" onClick={handleAddAccount} disabled={addLoading || !addUsername.trim()}>
                    {addLoading ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Plus className="mr-1.5 size-4" />}
                    Add
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
