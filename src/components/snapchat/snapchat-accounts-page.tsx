"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Trash2,
  RefreshCw,
  Loader2,
  FolderPlus,
  Users,
  X,
  Plus,
  ShieldCheck,
  ShieldAlert,
  HelpCircle,
  Copy,
  Check,
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

interface GroupInfo {
  id: string;
  name: string;
}

interface SnapAccount {
  id: string;
  username: string;
  displayName: string | null;
  status: string;
  lastCheckedAt: string | null;
  createdAt: string;
  groups: GroupInfo[];
}

interface CheckProgress {
  total: number;
  completed: number;
  current: string | null;
  alive: number;
  banned: number;
  running: boolean;
}

interface GroupWithCount {
  id: string;
  name: string;
  memberCount: number;
}

export function SnapchatAccountsPage() {
  const [accounts, setAccounts] = useState<SnapAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<GroupWithCount[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [checkProgress, setCheckProgress] = useState<CheckProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addUsernames, setAddUsernames] = useState("");
  const [addGroupId, setAddGroupId] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addResult, setAddResult] = useState("");

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [groupActionLoading, setGroupActionLoading] = useState(false);
  const [showManageGroup, setShowManageGroup] = useState(false);
  const [manageGroupId, setManageGroupId] = useState("");
  const [groupMembers, setGroupMembers] = useState<Array<{ accountId: string; username: string }>>([]);

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const params = selectedGroupId ? `?groupId=${selectedGroupId}` : "";
      const res = await fetch(`/api/snapchat/accounts${params}`, { cache: "no-store" });
      if (res.ok) setAccounts(await res.json());
    } catch {
    } finally {
      setLoading(false);
    }
  }, [selectedGroupId]);

  const fetchGroups = useCallback(async () => {
    try {
      const res = await fetch("/api/snapchat/groups", { cache: "no-store" });
      if (res.ok) setGroups(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  useEffect(() => {
    fetch("/api/snapchat/check", { cache: "no-store" })
      .then((r) => r.json())
      .then((p: CheckProgress) => {
        if (p.running) {
          setCheckProgress(p);
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
        const res = await fetch("/api/snapchat/check", { cache: "no-store" });
        const p: CheckProgress = await res.json();
        setCheckProgress(p);
        if (!p.running) {
          stopPolling();
          fetchAccounts();
        }
      } catch {}
    }, 2000);
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function handleCheckAll() {
    if (checkProgress?.running) return;
    try {
      const params = new URLSearchParams();
      if (selectedGroupId) params.set("groupId", selectedGroupId);
      const res = await fetch(`/api/snapchat/check?${params}`, { method: "POST" });
      if (res.ok || res.status === 409) {
        const data = await res.json();
        setCheckProgress(data.progress);
        startPolling();
      }
    } catch {}
  }

  async function handleDelete(e: React.MouseEvent, id: string, username: string) {
    e.stopPropagation();
    if (!confirm(`Delete @${username}?`)) return;
    try {
      const res = await fetch(`/api/snapchat/accounts?id=${id}`, { method: "DELETE" });
      if (res.ok) setAccounts((prev) => prev.filter((a) => a.id !== id));
    } catch {}
  }

  async function handleAddAccounts() {
    const usernames = addUsernames.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (usernames.length === 0) return;
    setAddLoading(true);
    setAddResult("");
    try {
      const res = await fetch("/api/snapchat/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames, groupId: addGroupId || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        const parts: string[] = [];
        if (data.added > 0) parts.push(`${data.added} added`);
        if (data.duplicates > 0) parts.push(`${data.duplicates} already exist`);
        setAddResult(parts.join(" · "));
        setAddUsernames("");
        await fetchAccounts();
        await fetchGroups();
      } else {
        setAddResult(data.error || "Failed");
      }
    } catch {
      setAddResult("Error adding accounts");
    } finally {
      setAddLoading(false);
    }
  }

  async function handleCreateGroup() {
    if (!newGroupName.trim()) return;
    setGroupActionLoading(true);
    try {
      const res = await fetch("/api/snapchat/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      if (res.ok) {
        setNewGroupName("");
        setShowCreateGroup(false);
        await fetchGroups();
      }
    } catch {} finally {
      setGroupActionLoading(false);
    }
  }

  async function handleDeleteGroup(groupId: string, groupName: string) {
    if (!confirm(`Delete group "${groupName}"?`)) return;
    try {
      const res = await fetch(`/api/snapchat/groups?id=${groupId}`, { method: "DELETE" });
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
      const res = await fetch(`/api/snapchat/accounts?groupId=${groupId}`, { cache: "no-store" });
      if (res.ok) {
        const data: SnapAccount[] = await res.json();
        setGroupMembers(data.map((a) => ({ accountId: a.id, username: a.username })));
      }
    } catch {}
  }

  async function handleRemoveFromGroup(accountId: string) {
    try {
      const res = await fetch(`/api/snapchat/groups/members?groupId=${manageGroupId}&accountId=${accountId}`, { method: "DELETE" });
      if (res.ok) {
        setGroupMembers((prev) => prev.filter((m) => m.accountId !== accountId));
        await fetchGroups();
        await fetchAccounts();
      }
    } catch {}
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
    if (selectedIds.size === accounts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(accounts.map((a) => a.id)));
    }
  }

  function handleCopyUsernames() {
    const usernames = accounts
      .filter((a) => selectedIds.has(a.id))
      .map((a) => a.username)
      .join("\n");
    navigator.clipboard.writeText(usernames);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const isChecking = checkProgress?.running ?? false;
  const aliveCount = accounts.filter((a) => a.status === "alive").length;
  const bannedCount = accounts.filter((a) => a.status === "banned").length;
  const unknownCount = accounts.filter((a) => a.status === "unknown").length;

  function StatusBadge({ status }: { status: string }) {
    if (status === "alive") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-0.5 text-xs font-medium text-green-500">
          <ShieldCheck className="size-3" /> Alive
        </span>
      );
    }
    if (status === "banned") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2.5 py-0.5 text-xs font-medium text-red-500">
          <ShieldAlert className="size-3" /> Banned
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
        <HelpCircle className="size-3" /> Unknown
      </span>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Snapchat Account Status</h1>
          <p className="text-sm text-muted-foreground">
            {accounts.length} accounts{selectedGroupId ? " in group" : " tracked"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <Button variant="outline" size="sm" onClick={handleCopyUsernames}>
              {copied ? (
                <Check className="mr-1.5 size-4 text-green-500" />
              ) : (
                <Copy className="mr-1.5 size-4" />
              )}
              {copied ? "Copied!" : `Copy ${selectedIds.size} username${selectedIds.size === 1 ? "" : "s"}`}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setShowAddDialog(true)}>
            <Plus className="mr-1.5 size-4" />
            Add Accounts
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowGroupDialog(true)}>
            <FolderPlus className="mr-1.5 size-4" />
            Groups
          </Button>
          <Button variant="outline" size="sm" onClick={handleCheckAll} disabled={isChecking}>
            {isChecking ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 size-4" />
            )}
            {isChecking
              ? "Checking..."
              : selectedGroupId
                ? `Check ${groups.find((g) => g.id === selectedGroupId)?.name || "Group"}`
                : "Check All"}
          </Button>
        </div>
      </div>

      {/* Group filter tabs */}
      {groups.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSelectedGroupId("")}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              !selectedGroupId ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            All
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              onClick={() => setSelectedGroupId(g.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                selectedGroupId === g.id ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {g.name} ({g.memberCount})
            </button>
          ))}
        </div>
      )}

      {/* Summary card */}
      {accounts.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4 flex items-center gap-6">
          <div>
            <p className="text-xs text-muted-foreground">Alive</p>
            <p className="text-2xl font-bold text-green-500">{aliveCount}</p>
          </div>
          <div className="h-10 w-px bg-border" />
          <div>
            <p className="text-xs text-muted-foreground">Banned</p>
            <p className="text-2xl font-bold text-red-500">{bannedCount}</p>
          </div>
          <div className="h-10 w-px bg-border" />
          <div>
            <p className="text-xs text-muted-foreground">Unknown</p>
            <p className="text-2xl font-bold text-muted-foreground">{unknownCount}</p>
          </div>
          <div className="h-10 w-px bg-border" />
          <div>
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-2xl font-bold">{accounts.length}</p>
          </div>
        </div>
      )}

      {/* Check progress */}
      {isChecking && checkProgress && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Checking {checkProgress.completed}/{checkProgress.total}
              {checkProgress.current && (
                <span className="ml-1.5 text-foreground font-medium">— @{checkProgress.current}</span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              <span className="text-green-500">{checkProgress.alive} alive</span>
              {" · "}
              <span className="text-red-500">{checkProgress.banned} banned</span>
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${checkProgress.total > 0 ? (checkProgress.completed / checkProgress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Table */}
      {loading && accounts.length === 0 ? (
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
                      checked={accounts.length > 0 && selectedIds.size === accounts.length}
                      onChange={toggleSelectAll}
                      className="size-4 rounded border-border accent-primary cursor-pointer"
                    />
                  </label>
                </TableHead>
                <TableHead>Username</TableHead>
                <TableHead>Display Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Checked</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    {selectedGroupId ? "No accounts in this group" : "No Snapchat accounts added yet"}
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((account) => (
                  <TableRow key={account.id} className={selectedIds.has(account.id) ? "bg-primary/5" : ""}>
                    <TableCell className="pl-4">
                      <label className="flex items-center justify-center cursor-pointer py-2 px-1">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(account.id)}
                          onChange={() => toggleSelect(account.id)}
                          className="size-4 rounded border-border accent-primary cursor-pointer"
                        />
                      </label>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <a
                          href={`https://www.snapchat.com/add/${account.username}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium hover:text-primary hover:underline"
                        >
                          @{account.username}
                        </a>
                        {account.groups.length > 0 && (
                          <div className="flex gap-1">
                            {account.groups.map((g) => (
                              <span key={g.id} className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                {g.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {account.displayName || "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={account.status} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {account.lastCheckedAt
                        ? new Date(account.lastCheckedAt).toLocaleDateString("en-US", {
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

      {/* Add Accounts Dialog */}
      {showAddDialog && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setShowAddDialog(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <h2 className="text-lg font-semibold">Add Snapchat Accounts</h2>
                <button onClick={() => setShowAddDialog(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="size-5" />
                </button>
              </div>
              <div className="p-5 space-y-4">
                <div>
                  <label className="text-sm font-medium">Usernames (comma or newline separated)</label>
                  <textarea
                    value={addUsernames}
                    onChange={(e) => setAddUsernames(e.target.value)}
                    placeholder={"username1, username2\nusername3"}
                    rows={5}
                    className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                {groups.length > 0 && (
                  <div>
                    <label className="text-sm font-medium">Add to Group</label>
                    <select
                      value={addGroupId}
                      onChange={(e) => setAddGroupId(e.target.value)}
                      className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    >
                      <option value="">No group</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>{g.name} ({g.memberCount})</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <Button onClick={handleAddAccounts} disabled={addLoading || !addUsernames.trim()}>
                    {addLoading ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Plus className="mr-1.5 size-4" />}
                    Add Accounts
                  </Button>
                  {addResult && <p className="text-xs text-muted-foreground">{addResult}</p>}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Groups Dialog */}
      {showGroupDialog && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setShowGroupDialog(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <h2 className="text-lg font-semibold">Snapchat Groups</h2>
                <button onClick={() => setShowGroupDialog(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="size-5" />
                </button>
              </div>
              <div className="max-h-[70vh] overflow-y-auto p-5 space-y-5">
                {groups.length > 0 && (
                  <div className="space-y-2">
                    {groups.map((g) => (
                      <div key={g.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Users className="size-4 text-muted-foreground" />
                          <span className="font-medium">{g.name}</span>
                          <span className="text-xs text-muted-foreground">({g.memberCount})</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => openManageGroup(g.id)}>
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
                {showCreateGroup ? (
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
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setShowCreateGroup(true)}>
                    <Plus className="mr-1.5 size-4" />
                    Create Group
                  </Button>
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
                  <p className="text-center text-sm text-muted-foreground py-8">No members</p>
                ) : (
                  <div className="space-y-1">
                    {groupMembers.map((m) => (
                      <div key={m.accountId} className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-accent/50">
                        <span className="text-sm font-medium">@{m.username}</span>
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
    </div>
  );
}
