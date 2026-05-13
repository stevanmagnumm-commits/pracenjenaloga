"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface BulkProgress {
  total: number;
  completed: number;
  current: string | null;
  successes: string[];
  errors: Array<{ username: string; error: string }>;
  running: boolean;
}

interface GroupInfo {
  id: string;
  name: string;
  memberCount: number;
}

interface TrackAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  platform: "instagram" | "threads" | "tiktok" | "snapchat";
}

type Mode = "single" | "bulk";

export function TrackAccountDialog({
  open,
  onOpenChange,
  onSuccess,
  platform,
}: TrackAccountDialogProps) {
  const [mode, setMode] = useState<Mode>("single");
  const [input, setInput] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [refreshInterval, setRefreshInterval] = useState("EIGHT_HOURS");
  const [priority, setPriority] = useState("2");
  const [postsLeft, setPostsLeft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [duplicates, setDuplicates] = useState<string[]>([]);
  const [checkedDuplicates, setCheckedDuplicates] = useState(false);

  const isThreads = platform === "threads";
  const singleEndpoint = isThreads ? "/api/threads/accounts" : "/api/accounts";
  const bulkEndpoint = isThreads ? "/api/threads/accounts/bulk" : "/api/accounts/bulk";
  const platformLabel = isThreads ? "Threads" : "Instagram";

  const fetchGroups = useCallback(async () => {
    if (platform === "tiktok") return;
    try {
      const res = await fetch("/api/groups", { cache: "no-store" });
      if (res.ok) setGroups(await res.json());
    } catch {}
  }, [platform]);

  useEffect(() => {
    if (open) fetchGroups();
  }, [open, fetchGroups]);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  useEffect(() => {
    return stopPolling;
  }, []);

  useEffect(() => {
    if (!open) {
      setInput("");
      setBulkText("");
      setError(null);
      setBulkProgress(null);
      setMode("single");
      setSelectedGroupId("");
      setDuplicates([]);
      setCheckedDuplicates(false);
      setPostsLeft("");
      stopPolling();
    }
  }, [open]);

  function parseUsernames(text: string): string[] {
    return text
      .split(/[\n,]+/)
      .map((l) => l.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/\/.*$/, ""))
      .filter(Boolean);
  }

  async function checkDuplicates() {
    const usernames = parseUsernames(bulkText);
    if (usernames.length === 0) return;

    setCheckedDuplicates(false);
    try {
      const res = await fetch("/api/accounts/stats?sort=totalViews&dir=desc", { cache: "no-store" });
      if (!res.ok) return;
      const accounts: Array<{ username: string }> = await res.json();
      const existingSet = new Set(accounts.map((a) => a.username.toLowerCase()));
      const dupes = usernames.filter((u) => existingSet.has(u.toLowerCase()));
      setDuplicates(dupes);
      setCheckedDuplicates(true);
    } catch {}
  }

  async function addToGroup(usernames: string[]) {
    if (!selectedGroupId || usernames.length === 0) return;
    try {
      await fetch("/api/groups/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: selectedGroupId, usernames }),
      });
    } catch {}
  }

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(bulkEndpoint);
        if (!res.ok) return;
        const data: BulkProgress = await res.json();
        setBulkProgress(data);
        if (!data.running) {
          stopPolling();
          setLoading(false);
          if (selectedGroupId) {
            const allUsernames = parseUsernames(bulkText);
            await addToGroup(allUsernames);
          }
          onSuccess();
        }
      } catch {}
    }, 2000);
  }

  async function handleSingleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const postsLeftNum = postsLeft.trim() === "" ? null : Number(postsLeft);
      const validPostsLeft = postsLeftNum !== null && Number.isFinite(postsLeftNum) && postsLeftNum >= 0;
      const res = await fetch(singleEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: input.trim(),
          ...(!isThreads && {
            refreshInterval,
            priority: Number(priority),
            ...(validPostsLeft && { postsLeft: postsLeftNum }),
          }),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to track account");
      }

      if (selectedGroupId && !isThreads) {
        const username = input.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/\/.*$/, "");
        await addToGroup([username]);
      }

      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }

  async function handleBulkSubmit(e: React.FormEvent) {
    e.preventDefault();
    const usernames = parseUsernames(bulkText);
    if (usernames.length === 0) return;

    const unique = [...new Set(usernames.map((u) => u.toLowerCase()))];
    const deduped = unique.map((u) => usernames.find((orig) => orig.toLowerCase() === u)!);

    setLoading(true);
    setError(null);
    setBulkProgress(null);

    try {
      const postsLeftNum = postsLeft.trim() === "" ? null : Number(postsLeft);
      const validPostsLeft = postsLeftNum !== null && Number.isFinite(postsLeftNum) && postsLeftNum >= 0;
      const res = await fetch(bulkEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usernames: deduped,
          ...(!isThreads && {
            refreshInterval,
            priority: Number(priority),
            ...(validPostsLeft && { postsLeft: postsLeftNum }),
          }),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to start bulk import");
      }

      const data = await res.json();

      if (data.total === 0) {
        if (selectedGroupId) {
          await addToGroup(deduped);
        }
        setError(data.message || "All accounts are already tracked");
        setLoading(false);
        if (selectedGroupId) onSuccess();
        return;
      }

      setBulkProgress({
        total: data.total,
        completed: 0,
        current: null,
        successes: [],
        errors: [],
        running: true,
      });
      startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setLoading(false);
    }
  }

  function handleClose(value: boolean) {
    if (!loading) {
      onOpenChange(value);
    }
  }

  const isImporting = loading && bulkProgress?.running;
  const isDone = bulkProgress && !bulkProgress.running && bulkProgress.completed > 0;
  const placeholder = isThreads
    ? "e.g. @username or https://threads.net/@username"
    : "e.g. @username or https://instagram.com/username";
  const bulkPlaceholder = isThreads
    ? "username1\nusername2\nhttps://threads.net/@username3"
    : "Paste usernames separated by commas or new lines\nusername1, username2\nusername3";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Track {platformLabel} Accounts</DialogTitle>
          <DialogDescription>
            {isThreads
              ? "Add Threads accounts to track follower growth over time."
              : "Add a single account or bulk import multiple at once."}
          </DialogDescription>
        </DialogHeader>

        {!isImporting && !isDone && (
          <>
            <div className="flex gap-2 rounded-lg bg-muted p-1">
              <button
                onClick={() => setMode("single")}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === "single"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Single Account
              </button>
              <button
                onClick={() => setMode("bulk")}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === "bulk"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Bulk Import
              </button>
            </div>

            <form
              onSubmit={mode === "single" ? handleSingleSubmit : handleBulkSubmit}
              className="space-y-4"
            >
              {mode === "single" ? (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Username or URL</label>
                  <Input
                    placeholder={placeholder}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={loading}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Usernames (one per line or comma-separated)
                  </label>
                  <textarea
                    className="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    placeholder={bulkPlaceholder}
                    value={bulkText}
                    onChange={(e) => {
                      setBulkText(e.target.value);
                      setCheckedDuplicates(false);
                      setDuplicates([]);
                    }}
                    disabled={loading}
                  />
                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={checkDuplicates}
                      disabled={!bulkText.trim()}
                    >
                      Check for Duplicates
                    </Button>
                    {checkedDuplicates && (
                      <span className="text-xs text-muted-foreground">
                        {duplicates.length === 0 ? (
                          <span className="text-green-500">No duplicates found</span>
                        ) : (
                          <span className="text-yellow-500">
                            {duplicates.length} already tracked
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  {checkedDuplicates && duplicates.length > 0 && (
                    <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-yellow-500 mb-1.5">
                        <AlertTriangle className="size-3.5" />
                        Already tracked ({duplicates.length}):
                      </div>
                      <p className="text-xs text-yellow-500/80">
                        {duplicates.join(", ")}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-1.5">
                        These will be skipped during import but still added to the selected group.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Group selector */}
              {!isThreads && groups.length > 0 && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Add to Group</label>
                  <select
                    value={selectedGroupId}
                    onChange={(e) => setSelectedGroupId(e.target.value)}
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none"
                  >
                    <option value="">No group</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} ({g.memberCount})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {!isThreads && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Refresh Interval</label>
                    <Select
                      value={refreshInterval}
                      onValueChange={setRefreshInterval}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ONE_HOUR">Every hour</SelectItem>
                        <SelectItem value="EIGHT_HOURS">Every 8 hours</SelectItem>
                        <SelectItem value="TWELVE_HOURS">Every 12 hours</SelectItem>
                        <SelectItem value="DAILY">Daily</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Priority</label>
                    <Select value={priority} onValueChange={setPriority}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1 — High</SelectItem>
                        <SelectItem value="2">2 — Medium</SelectItem>
                        <SelectItem value="3">3 — Low</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {!isThreads && (
                <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                  <label className="text-sm font-medium">
                    Posts left (auto-add to Scheduler)
                  </label>
                  <Input
                    type="number"
                    min={0}
                    placeholder="e.g. 20"
                    value={postsLeft}
                    onChange={(e) => setPostsLeft(e.target.value)}
                    disabled={loading}
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional. If set, accounts are added to the Scheduler with
                    expiry = today + N days. Category is auto-detected from
                    avg views of the last 36 reels.
                  </p>
                </div>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}

              <DialogFooter>
                <Button
                  type="submit"
                  disabled={
                    loading ||
                    (mode === "single" ? !input.trim() : !bulkText.trim())
                  }
                >
                  {loading && <Loader2 className="size-4 animate-spin" />}
                  {mode === "single"
                    ? loading
                      ? "Importing..."
                      : "Track Account"
                    : loading
                      ? "Importing..."
                      : "Start Bulk Import"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}

        {(isImporting || isDone) && bulkProgress && (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {bulkProgress.running
                    ? `Importing ${bulkProgress.completed + 1}/${bulkProgress.total}`
                    : `Done — ${bulkProgress.completed}/${bulkProgress.total}`}
                </span>
                {bulkProgress.current && (
                  <span className="font-mono text-foreground">
                    @{bulkProgress.current}
                  </span>
                )}
              </div>
              <Progress value={bulkProgress.completed} max={bulkProgress.total} />
            </div>

            {selectedGroupId && isDone && (
              <p className="text-xs text-green-500">
                Added to group: {groups.find((g) => g.id === selectedGroupId)?.name}
              </p>
            )}

            {bulkProgress.successes.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Imported ({bulkProgress.successes.length})
                </p>
                <div className="max-h-32 space-y-0.5 overflow-y-auto">
                  {bulkProgress.successes.map((u) => (
                    <div
                      key={u}
                      className="flex items-center gap-1.5 text-sm text-green-500"
                    >
                      <CheckCircle2 className="size-3.5 shrink-0" />@{u}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {bulkProgress.errors.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Errors ({bulkProgress.errors.length})
                </p>
                <div className="max-h-32 space-y-0.5 overflow-y-auto">
                  {bulkProgress.errors.map((e) => (
                    <div
                      key={e.username}
                      className="flex items-center gap-1.5 text-sm text-destructive"
                    >
                      <XCircle className="size-3.5 shrink-0" />@{e.username}:{" "}
                      {e.error}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isDone && (
              <DialogFooter>
                <Button variant="outline" onClick={() => handleClose(false)}>
                  Close
                </Button>
              </DialogFooter>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
