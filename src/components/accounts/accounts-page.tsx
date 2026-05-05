"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpDown,
  Trash2,
  RefreshCw,
  Loader2,
  FolderPlus,
  Users,
  X,
  Plus,
  Copy,
  Check,
  ShieldAlert,
} from "lucide-react";
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

interface GroupInfo {
  id: string;
  name: string;
}

interface AccountStat {
  id: string;
  username: string;
  fullName: string | null;
  isVerified: boolean;
  status: string;
  importing: boolean;
  videosTracked: number;
  totalMediaCount: number;
  totalViews: number;
  avgVideoViews: number;
  avgLast36Views: number;
  lastPosted: string | null;
  lastTracked: string | null;
  createdAt: string;
  groups: GroupInfo[];
}

interface RefreshProgress {
  total: number;
  completed: number;
  current: string | null;
  errors: Array<{ username: string; error: string }>;
  running: boolean;
}

interface GroupWithCount {
  id: string;
  name: string;
  memberCount: number;
}

type SortField = "totalViews" | "videosTracked" | "avgVideoViews" | "avgLast36Views" | "lastPosted" | "lastTracked";
type SortDir = "asc" | "desc";

export function AccountsPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<AccountStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortField>("totalViews");
  const [dir, setDir] = useState<SortDir>("desc");
  const [refreshProgress, setRefreshProgress] = useState<RefreshProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [groups, setGroups] = useState<GroupWithCount[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [showOdlicni, setShowOdlicni] = useState(false);
  const [showBanned, setShowBanned] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [addToGroupId, setAddToGroupId] = useState("");
  const [addUsernames, setAddUsernames] = useState("");
  const [groupActionResult, setGroupActionResult] = useState("");
  const [groupActionLoading, setGroupActionLoading] = useState(false);
  const [showManageGroup, setShowManageGroup] = useState(false);
  const [manageGroupId, setManageGroupId] = useState("");
  const [groupMembers, setGroupMembers] = useState<Array<{ id: string; accountId: string; username: string; fullName: string | null }>>([]);
  const [showCopyDialog, setShowCopyDialog] = useState(false);
  const [copyStatusFilter, setCopyStatusFilter] = useState<"all" | "odlicni" | "banned">("all");
  const [copyGroupFilter, setCopyGroupFilter] = useState<"all" | "noGroup" | string>("all");
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "single" | "bulk"; id?: string; username?: string; count?: number } | null>(null);

  const fetchGroups = useCallback(async () => {
    try {
      const res = await fetch("/api/groups", { cache: "no-store" });
      if (res.ok) setGroups(await res.json());
    } catch {}
  }, []);

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort, dir });
      if (selectedGroupId) params.set("groupId", selectedGroupId);
      const res = await fetch(`/api/accounts/stats?${params}`, { cache: "no-store" });
      if (res.ok) setAccounts(await res.json());
    } catch {
    } finally {
      setLoading(false);
    }
  }, [sort, dir, selectedGroupId]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // While any account is still in the import queue, re-poll the stats so the
  // user sees them populate (and disappear from the "Importing" pin) in real
  // time without a manual refresh.
  useEffect(() => {
    const anyImporting = accounts.some((a) => a.importing);
    if (!anyImporting) return;
    const id = setInterval(() => {
      fetchAccounts();
    }, 5000);
    return () => clearInterval(id);
  }, [accounts, fetchAccounts]);

  useEffect(() => {
    fetch("/api/refresh", { cache: "no-store" })
      .then((r) => r.json())
      .then((p: RefreshProgress) => {
        if (p.running) {
          setRefreshProgress(p);
          startPolling();
        }
      })
      .catch(() => {});
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/refresh", { cache: "no-store" });
        const p: RefreshProgress = await res.json();
        setRefreshProgress(p);
        if (!p.running) {
          stopPolling();
          fetchAccounts();
        }
      } catch {}
    }, 3000);
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function handleRefreshAll() {
    if (refreshProgress?.running) return;
    try {
      const params = new URLSearchParams({ all: "true" });
      if (selectedGroupId) params.set("groupId", selectedGroupId);
      const res = await fetch(`/api/refresh?${params}`, { method: "POST" });
      if (res.ok || res.status === 409) {
        const data = await res.json();
        setRefreshProgress(data.progress);
        startPolling();
      }
    } catch {}
  }

  function handleDelete(e: React.MouseEvent, accountId: string, username: string) {
    e.stopPropagation();
    setDeleteConfirm({ type: "single", id: accountId, username });
  }

  async function confirmDeleteSingle() {
    if (!deleteConfirm || deleteConfirm.type !== "single" || !deleteConfirm.id) return;
    try {
      const res = await fetch(`/api/accounts?id=${deleteConfirm.id}`, { method: "DELETE" });
      if (res.ok) setAccounts((prev) => prev.filter((a) => a.id !== deleteConfirm.id));
    } catch {}
    setDeleteConfirm(null);
  }

  async function handleCreateGroup() {
    if (!newGroupName.trim()) return;
    setGroupActionLoading(true);
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      if (res.ok) {
        setNewGroupName("");
        setShowCreateGroup(false);
        await fetchGroups();
        setGroupActionResult("Group created!");
      } else {
        const data = await res.json();
        setGroupActionResult(data.error || "Failed to create group");
      }
    } catch {
      setGroupActionResult("Error creating group");
    } finally {
      setGroupActionLoading(false);
    }
  }

  async function handleMassAdd() {
    if (!addToGroupId || !addUsernames.trim()) return;
    setGroupActionLoading(true);
    setGroupActionResult("");
    const usernames = addUsernames.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    try {
      const res = await fetch("/api/groups/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: addToGroupId, usernames }),
      });
      const data = await res.json();
      if (res.ok) {
        const parts: string[] = [];
        if (data.added > 0) parts.push(`${data.added} added`);
        if (data.alreadyInGroup > 0) parts.push(`${data.alreadyInGroup} already in group`);
        if (data.notFound?.length > 0) parts.push(`${data.notFound.length} not found: ${data.notFound.join(", ")}`);
        setGroupActionResult(parts.join(" · "));
        setAddUsernames("");
        await fetchGroups();
        await fetchAccounts();
      } else {
        setGroupActionResult(data.error || "Failed");
      }
    } catch {
      setGroupActionResult("Error adding accounts");
    } finally {
      setGroupActionLoading(false);
    }
  }

  async function handleDeleteGroup(groupId: string, groupName: string) {
    if (!confirm(`Delete group "${groupName}"? Accounts will NOT be deleted.`)) return;
    try {
      const res = await fetch(`/api/groups?id=${groupId}`, { method: "DELETE" });
      if (res.ok) {
        await fetchGroups();
        if (selectedGroupId === groupId) setSelectedGroupId("");
        await fetchAccounts();
      }
    } catch {}
  }

  async function openManageGroup(groupId: string) {
    setManageGroupId(groupId);
    setShowManageGroup(true);
    try {
      const res = await fetch(`/api/groups/members?groupId=${groupId}`, { cache: "no-store" });
      if (res.ok) setGroupMembers(await res.json());
    } catch {}
  }

  async function handleRemoveFromGroup(accountId: string) {
    try {
      const res = await fetch(`/api/groups/members?groupId=${manageGroupId}&accountId=${accountId}`, { method: "DELETE" });
      if (res.ok) {
        setGroupMembers((prev) => prev.filter((m) => m.accountId !== accountId));
        await fetchGroups();
        await fetchAccounts();
      }
    } catch {}
  }

  function handleSort(field: SortField) {
    if (sort === field) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setDir("desc");
    }
  }

  function SortableHeader({
    field,
    children,
    className,
  }: {
    field: SortField;
    children: React.ReactNode;
    className?: string;
  }) {
    return (
      <TableHead className={className}>
        <button
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          onClick={() => handleSort(field)}
        >
          {children}
          <ArrowUpDown
            className={`size-3 ${sort === field ? "text-primary" : "text-muted-foreground/50"}`}
          />
        </button>
      </TableHead>
    );
  }

  function toggleSelect(id: string, shiftKey: boolean) {
    if (shiftKey && lastClickedId && lastClickedId !== id) {
      // Shift+click: select range
      const ids = displayedAccounts.map((a) => a.id);
      const lastIdx = ids.indexOf(lastClickedId);
      const currentIdx = ids.indexOf(id);
      if (lastIdx !== -1 && currentIdx !== -1) {
        const start = Math.min(lastIdx, currentIdx);
        const end = Math.max(lastIdx, currentIdx);
        const rangeIds = ids.slice(start, end + 1);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          rangeIds.forEach((rid) => next.add(rid));
          return next;
        });
        return;
      }
    }
    
    // Normal click: toggle single
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastClickedId(id);
  }

  function toggleSelectAll() {
    if (selectedIds.size === displayedAccounts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(displayedAccounts.map((a) => a.id)));
    }
  }

  function handleCopyUsernames() {
    const usernames = displayedAccounts
      .filter((a) => selectedIds.has(a.id))
      .map((a) => a.username)
      .join("\n");
    navigator.clipboard.writeText(usernames);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function getFilteredAccountsForCopy() {
    return accounts.filter((a) => {
      // Status filter (AND logic)
      if (copyStatusFilter === "odlicni" && a.avgLast36Views < 800) return false;
      if (copyStatusFilter === "banned" && a.status !== "possibly_banned") return false;
      
      // Group filter (AND logic)
      if (copyGroupFilter === "noGroup" && a.groups.length > 0) return false;
      if (copyGroupFilter !== "all" && copyGroupFilter !== "noGroup") {
        if (!a.groups.some((g) => g.id === copyGroupFilter)) return false;
      }
      
      return true;
    });
  }

  function handleCopyFiltered() {
    const filtered = getFilteredAccountsForCopy();
    const usernames = filtered.map((a) => a.username).join("\n");
    navigator.clipboard.writeText(usernames);
    setCopied(true);
    setShowCopyDialog(false);
    setTimeout(() => setCopied(false), 2000);
  }

  function getCopyPreviewCount() {
    return getFilteredAccountsForCopy().length;
  }

  function handleBulkDelete() {
    setDeleteConfirm({ type: "bulk", count: selectedIds.size });
  }

  async function confirmDeleteBulk() {
    if (!deleteConfirm || deleteConfirm.type !== "bulk") return;
    const count = selectedIds.size;
    try {
      const ids = Array.from(selectedIds);
      const results = await Promise.all(
        ids.map((id) => fetch(`/api/accounts?id=${id}`, { method: "DELETE" }))
      );
      const deleted = results.filter((r) => r.ok).length;
      setAccounts((prev) => prev.filter((a) => !selectedIds.has(a.id)));
      setSelectedIds(new Set());
      if (deleted < count) {
        alert(`Deleted ${deleted} of ${count} accounts. Some may have failed.`);
      }
    } catch {
      alert("Error deleting accounts");
    }
    setDeleteConfirm(null);
  }

  const isRefreshing = refreshProgress?.running ?? false;

  // Filter for special categories
  const displayedAccounts = showOdlicni
    ? accounts.filter((a) => a.avgLast36Views >= 800)
    : showBanned
      ? accounts.filter((a) => a.status === "possibly_banned")
      : accounts;

  const qualifiedAccounts = displayedAccounts.filter((a) => a.avgVideoViews >= 50);
  const groupAvgViews =
    qualifiedAccounts.length > 0
      ? Math.round(
          qualifiedAccounts.reduce((sum, a) => sum + a.avgVideoViews, 0) /
            qualifiedAccounts.length
        )
      : 0;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">All Accounts</h1>
          <p className="text-sm text-muted-foreground">
            {displayedAccounts.length} accounts{showOdlicni ? " (Odlicni)" : showBanned ? " (Banned)" : selectedGroupId ? " in group" : " tracked"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={handleCopyUsernames}>
                {copied ? (
                  <Check className="mr-1.5 size-4 text-green-500" />
                ) : (
                  <Copy className="mr-1.5 size-4" />
                )}
                {copied ? "Copied!" : `Copy ${selectedIds.size}`}
              </Button>
              <Button variant="outline" size="sm" onClick={handleBulkDelete} className="text-red-500 hover:text-red-400 hover:bg-red-500/10">
                <Trash2 className="mr-1.5 size-4" />
                Delete {selectedIds.size}
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" onClick={() => setShowCopyDialog(true)}>
            <Copy className="mr-1.5 size-4" />
            Copy...
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowGroupDialog(true)}>
            <FolderPlus className="mr-1.5 size-4" />
            Groups
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefreshAll} disabled={isRefreshing}>
            {isRefreshing ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 size-4" />
            )}
            {isRefreshing
              ? "Refreshing..."
              : selectedGroupId
                ? `Refresh ${groups.find((g) => g.id === selectedGroupId)?.name || "Group"}`
                : "Refresh All"}
          </Button>
        </div>
      </div>

      {/* Group filter tabs */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => { setSelectedGroupId(""); setShowOdlicni(false); setShowBanned(false); }}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            !selectedGroupId && !showOdlicni && !showBanned
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          All
        </button>
        <button
          onClick={() => { setSelectedGroupId(""); setShowOdlicni(true); setShowBanned(false); }}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            showOdlicni
              ? "bg-green-500/20 text-green-400"
              : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          ⭐ Odlicni ({accounts.filter((a) => a.avgLast36Views >= 800).length})
        </button>
        <button
          onClick={() => { setSelectedGroupId(""); setShowOdlicni(false); setShowBanned(true); }}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            showBanned
              ? "bg-red-500/20 text-red-400"
              : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          🚫 Banned ({accounts.filter((a) => a.status === "possibly_banned").length})
        </button>
        {groups.map((g) => (
          <button
            key={g.id}
            onClick={() => { setSelectedGroupId(g.id); setShowOdlicni(false); setShowBanned(false); }}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              selectedGroupId === g.id
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {g.name} ({g.memberCount})
          </button>
        ))}
      </div>

      {/* Category average views */}
      {displayedAccounts.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4 flex items-center gap-6">
          <div>
            <p className="text-xs text-muted-foreground">Avg Views per Video</p>
            <p className="text-2xl font-bold">{formatNumber(groupAvgViews)}</p>
          </div>
          <div className="h-10 w-px bg-border" />
          <div>
            <p className="text-xs text-muted-foreground">Accounts counted</p>
            <p className="text-2xl font-bold">
              {qualifiedAccounts.length}
              <span className="text-sm font-normal text-muted-foreground ml-1">
                / {displayedAccounts.length}
              </span>
            </p>
          </div>
          <p className="text-[10px] text-muted-foreground ml-auto">
            Excludes accounts with &lt;50 avg views
          </p>
        </div>
      )}

      {/* Refresh progress */}
      {isRefreshing && refreshProgress && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Refreshing {refreshProgress.completed}/{refreshProgress.total} accounts
              {refreshProgress.current && (
                <span className="ml-1.5 text-foreground font-medium">
                  — @{refreshProgress.current}
                </span>
              )}
            </span>
            {refreshProgress.errors.length > 0 && (
              <span className="text-red-400">
                {refreshProgress.errors.length} error{refreshProgress.errors.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{
                width: `${refreshProgress.total > 0 ? (refreshProgress.completed / refreshProgress.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Refresh errors */}
      {!isRefreshing && refreshProgress && refreshProgress.completed > 0 && refreshProgress.errors.length > 0 && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm font-medium text-red-400 mb-1">
            Refresh completed with {refreshProgress.errors.length} error{refreshProgress.errors.length !== 1 ? "s" : ""}:
          </p>
          <ul className="text-xs text-red-400/80 space-y-0.5">
            {refreshProgress.errors.slice(0, 10).map((err, i) => (
              <li key={i}>@{err.username}: {err.error}</li>
            ))}
            {refreshProgress.errors.length > 10 && (
              <li>...and {refreshProgress.errors.length - 10} more</li>
            )}
          </ul>
        </div>
      )}

      {/* Table */}
      {loading && displayedAccounts.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 pl-4">
                  <label className="flex items-center justify-center cursor-pointer py-1 px-1">
                    <input
                      type="checkbox"
                      checked={displayedAccounts.length > 0 && selectedIds.size === displayedAccounts.length}
                      onChange={toggleSelectAll}
                      className="size-4 rounded border-border accent-primary cursor-pointer"
                    />
                  </label>
                </TableHead>
                <TableHead>Account</TableHead>
                <SortableHeader field="videosTracked">Videos</SortableHeader>
                <SortableHeader field="totalViews" className="text-right">Total Views</SortableHeader>
                <SortableHeader field="avgVideoViews" className="text-right">Avg Views</SortableHeader>
                <SortableHeader field="avgLast36Views" className="text-right">Avg (last 36)</SortableHeader>
                <SortableHeader field="lastPosted">Last Posted</SortableHeader>
                <SortableHeader field="lastTracked">Last Tracked</SortableHeader>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayedAccounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                    {showOdlicni ? "No accounts with 800+ avg views" : showBanned ? "No banned accounts" : selectedGroupId ? "No accounts in this group" : "No accounts tracked yet"}
                  </TableCell>
                </TableRow>
              ) : (
                displayedAccounts.map((account) => (
                  <TableRow
                    key={account.id}
                    className={`cursor-pointer hover:bg-accent/50 ${selectedIds.has(account.id) ? "bg-primary/5" : ""}`}
                    onClick={() => router.push(`/account/${account.id}`)}
                  >
                    <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
                      <label className="flex items-center justify-center cursor-pointer py-2 px-1">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(account.id)}
                          onChange={(e) => toggleSelect(account.id, e.nativeEvent.shiftKey)}
                          className="size-4 rounded border-border accent-primary cursor-pointer"
                        />
                      </label>
                    </TableCell>
                    <TableCell>
                      <div>
                        <div className="flex items-center gap-2">
                          <a
                            href={`https://www.instagram.com/${account.username}/`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium hover:text-primary hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            @{account.username}
                          </a>
                          {account.importing && (
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
                              <Loader2 className="size-3 animate-spin" />
                              Importing
                            </span>
                          )}
                          {account.status === "possibly_banned" && (
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-500">
                              <ShieldAlert className="size-3" />
                              Banned
                            </span>
                          )}
                          {account.groups.length > 0 && (
                            <div className="flex gap-1">
                              {account.groups.map((g) => (
                                <span
                                  key={g.id}
                                  className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                                >
                                  {g.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        {account.fullName && (
                          <p className="text-xs text-muted-foreground">{account.fullName}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {account.videosTracked}
                      <span className="text-muted-foreground"> / {account.totalMediaCount}</span>
                    </TableCell>
                    <TableCell className="text-right font-medium">{formatNumber(account.totalViews)}</TableCell>
                    <TableCell className="text-right font-medium">{formatNumber(account.avgVideoViews)}</TableCell>
                    <TableCell className="text-right font-medium">{formatNumber(account.avgLast36Views)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {account.lastPosted
                        ? new Date(account.lastPosted).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          })
                        : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {account.lastTracked
                        ? new Date(account.lastTracked).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "Never"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        onClick={(e) => handleDelete(e, account.id, account.username)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Groups Dialog */}
      {showGroupDialog && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setShowGroupDialog(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <h2 className="text-lg font-semibold">Groups</h2>
                <button onClick={() => setShowGroupDialog(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="size-5" />
                </button>
              </div>

              <div className="max-h-[70vh] overflow-y-auto p-5 space-y-5">
                {/* Existing groups */}
                {groups.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-muted-foreground">Your Groups</h3>
                    {groups.map((g) => (
                      <div key={g.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Users className="size-4 text-muted-foreground" />
                          <span className="font-medium">{g.name}</span>
                          <span className="text-xs text-muted-foreground">({g.memberCount})</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => openManageGroup(g.id)}
                          >
                            Manage
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-destructive"
                            onClick={() => handleDeleteGroup(g.id, g.name)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Create group */}
                {showCreateGroup ? (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-muted-foreground">New Group</h3>
                    <div className="flex gap-2">
                      <input
                        value={newGroupName}
                        onChange={(e) => setNewGroupName(e.target.value)}
                        placeholder="Group name"
                        className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                        onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
                      />
                      <Button size="sm" onClick={handleCreateGroup} disabled={groupActionLoading || !newGroupName.trim()}>
                        Create
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setShowCreateGroup(false); setNewGroupName(""); }}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setShowCreateGroup(true)}>
                    <Plus className="mr-1.5 size-4" />
                    Create Group
                  </Button>
                )}

                {/* Mass add to group */}
                {groups.length > 0 && (
                  <div className="space-y-3 border-t border-border pt-4">
                    <h3 className="text-sm font-medium text-muted-foreground">Add Accounts to Group</h3>
                    <select
                      value={addToGroupId}
                      onChange={(e) => setAddToGroupId(e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    >
                      <option value="">Select a group...</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>{g.name} ({g.memberCount})</option>
                      ))}
                    </select>
                    <textarea
                      value={addUsernames}
                      onChange={(e) => setAddUsernames(e.target.value)}
                      placeholder={"Paste usernames separated by commas or new lines\ne.g. user1, user2, user3"}
                      rows={4}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <div className="flex items-center gap-3">
                      <Button
                        size="sm"
                        onClick={handleMassAdd}
                        disabled={groupActionLoading || !addToGroupId || !addUsernames.trim()}
                      >
                        {groupActionLoading ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <FolderPlus className="mr-1.5 size-4" />}
                        Add to Group
                      </Button>
                      {groupActionResult && (
                        <p className="text-xs text-muted-foreground">{groupActionResult}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Manage Group Members Dialog */}
      {showManageGroup && (
        <>
          <div className="fixed inset-0 z-[60] bg-black/60" onClick={() => setShowManageGroup(false)} />
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <h2 className="text-lg font-semibold">
                  {groups.find((g) => g.id === manageGroupId)?.name || "Group"} Members
                </h2>
                <button onClick={() => setShowManageGroup(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="size-5" />
                </button>
              </div>
              <div className="max-h-[60vh] overflow-y-auto p-5">
                {groupMembers.length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground py-8">No members in this group</p>
                ) : (
                  <div className="space-y-1">
                    {groupMembers.map((m) => (
                      <div key={m.accountId} className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-accent/50">
                        <div>
                          <span className="text-sm font-medium">@{m.username}</span>
                          {m.fullName && (
                            <span className="ml-2 text-xs text-muted-foreground">{m.fullName}</span>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-muted-foreground hover:text-destructive"
                          onClick={() => handleRemoveFromGroup(m.accountId)}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <>
          <div className="fixed inset-0 z-[70] bg-black/60" onClick={() => setDeleteConfirm(null)} />
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-xl border border-red-500/30 bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-full bg-red-500/10">
                    <Trash2 className="size-5 text-red-500" />
                  </div>
                  <h2 className="text-lg font-semibold">Confirm Delete</h2>
                </div>
                
                <p className="text-sm text-muted-foreground">
                  {deleteConfirm.type === "single" 
                    ? <>Are you sure you want to delete <span className="font-medium text-foreground">@{deleteConfirm.username}</span> and all its data?</>
                    : <>Are you sure you want to delete <span className="font-medium text-foreground">{deleteConfirm.count} accounts</span> and all their data?</>
                  }
                </p>
                <p className="text-xs text-red-400">This action cannot be undone.</p>

                <div className="flex gap-2 pt-2">
                  <Button 
                    variant="outline" 
                    className="flex-1" 
                    onClick={() => setDeleteConfirm(null)}
                  >
                    Cancel
                  </Button>
                  <Button 
                    className="flex-1 bg-red-500 hover:bg-red-600 text-white"
                    onClick={deleteConfirm.type === "single" ? confirmDeleteSingle : confirmDeleteBulk}
                  >
                    <Trash2 className="mr-1.5 size-4" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Copy Dialog */}
      {showCopyDialog && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setShowCopyDialog(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <h2 className="text-lg font-semibold">Copy Usernames</h2>
                <button onClick={() => setShowCopyDialog(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="size-5" />
                </button>
              </div>
              <div className="p-5 space-y-4">
                {/* Status Filter */}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">Status</p>
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="copyStatus"
                        checked={copyStatusFilter === "all"}
                        onChange={() => setCopyStatusFilter("all")}
                        className="size-4 accent-primary"
                      />
                      <span className="text-sm">All statuses</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="copyStatus"
                        checked={copyStatusFilter === "odlicni"}
                        onChange={() => setCopyStatusFilter("odlicni")}
                        className="size-4 accent-primary"
                      />
                      <span className="text-sm text-green-400">⭐ Odlicni only</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="copyStatus"
                        checked={copyStatusFilter === "banned"}
                        onChange={() => setCopyStatusFilter("banned")}
                        className="size-4 accent-primary"
                      />
                      <span className="text-sm text-red-400">🚫 Banned only</span>
                    </label>
                  </div>
                </div>

                {/* Group Filter */}
                <div className="border-t border-border pt-4">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Group</p>
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="copyGroup"
                        checked={copyGroupFilter === "all"}
                        onChange={() => setCopyGroupFilter("all")}
                        className="size-4 accent-primary"
                      />
                      <span className="text-sm">All groups</span>
                    </label>
                    {groups.map((g) => (
                      <label key={g.id} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="copyGroup"
                          checked={copyGroupFilter === g.id}
                          onChange={() => setCopyGroupFilter(g.id)}
                          className="size-4 accent-primary"
                        />
                        <span className="text-sm">{g.name}</span>
                      </label>
                    ))}
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="copyGroup"
                        checked={copyGroupFilter === "noGroup"}
                        onChange={() => setCopyGroupFilter("noGroup")}
                        className="size-4 accent-primary"
                      />
                      <span className="text-sm text-muted-foreground">No group</span>
                    </label>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <span className="text-sm text-muted-foreground">
                    {getCopyPreviewCount()} accounts
                  </span>
                  <Button size="sm" onClick={handleCopyFiltered} disabled={getCopyPreviewCount() === 0}>
                    {copied ? <Check className="mr-1.5 size-4 text-green-500" /> : <Copy className="mr-1.5 size-4" />}
                    {copied ? "Copied!" : "Copy"}
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
