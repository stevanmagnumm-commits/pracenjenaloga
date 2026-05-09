"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Upload, Trash2, ArrowUpDown, X, Loader2, Calendar, Copy, Check } from "lucide-react";
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
  const [urgencyFilter, setUrgencyFilter] = useState<string>("all");
  const [editingDateId, setEditingDateId] = useState<string | null>(null);
  const [editDateValue, setEditDateValue] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
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

  async function handleDelete(id: string, username: string) {
    if (!confirm(`Remove @${username} from scheduler?`)) return;
    try {
      await fetch(`/api/scheduler?id=${id}`, { method: "DELETE" });
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
    if (urgencyFilter !== "all" && e.urgencyStatus !== urgencyFilter) return false;
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
        const catOrder: Record<string, number> = { "ODLIČAN": 1, "DOBAR": 2, "SREDNJI": 3 };
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
    srednji: entries.filter((e) => e.category === "SREDNJI").length,
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
      "SREDNJI": "bg-red-500/10 text-red-400",
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
            <Button variant="outline" size="sm" onClick={handleCopySelected}>
              {copied ? <Check className="mr-1.5 size-4 text-green-500" /> : <Copy className="mr-1.5 size-4" />}
              {copied ? "Copied!" : `Copy ${selectedIds.size}`}
            </Button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileUpload}
            className="hidden"
          />
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
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">ODLIČAN</p>
            <p className="text-2xl font-bold text-green-400">{stats.odlican}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">DOBAR</p>
            <p className="text-2xl font-bold text-yellow-400">{stats.dobar}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">SREDNJI</p>
            <p className="text-2xl font-bold text-red-400">{stats.srednji}</p>
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
          {["all", "ODLIČAN", "DOBAR", "SREDNJI"].map((c) => (
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
          <span className="text-xs text-muted-foreground mx-2">·</span>
          <span className="text-xs text-muted-foreground mr-1">Urgency:</span>
          {[
            { v: "all", l: "All" },
            { v: "expired", l: "ISTEKAO" },
            { v: "urgent", l: "Hitno" },
            { v: "soon", l: "Uskoro" },
            { v: "ok", l: "U redu" },
            { v: "no_date", l: "Bez datuma" },
          ].map((u) => (
            <button
              key={u.v}
              onClick={() => setUrgencyFilter(u.v)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                urgencyFilter === u.v ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {u.l}
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
                <SortableHeader field="daysRemaining">Status</SortableHeader>
                <SortableHeader field="avgLast36Views" className="text-right">Avg (last 36)</SortableHeader>
                <TableHead>Note</TableHead>
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
                    <div className="flex items-center gap-2">
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
                  <TableCell>{urgencyBadge(entry)}</TableCell>
                  <TableCell className="text-right font-medium">
                    {entry.isTracked ? formatNumber(entry.avgLast36Views) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                    {entry.note || "—"}
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
    </div>
  );
}
