"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Loader2,
  Play,
  Copy,
  Check,
  Trash2,
  ExternalLink,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRowSelection, openInstagramTabs } from "@/lib/use-row-selection";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface BanCheckResult {
  username: string;
  status: "alive" | "banned" | "inconclusive";
}

interface CheckProgress {
  total: number;
  completed: number;
  current: string | null;
  alive: number;
  banned: number;
  inconclusive: number;
  running: boolean;
  results: BanCheckResult[];
}

type FilterMode = "all" | "alive" | "banned" | "inconclusive";

export function IgBanCheckerPage() {
  const [input, setInput] = useState("");
  const [progress, setProgress] = useState<CheckProgress | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollProgress = useCallback(async () => {
    try {
      const res = await fetch("/api/ig-ban-check", { cache: "no-store" });
      const data: CheckProgress = await res.json();
      setProgress(data);
      if (!data.running && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {}
  }, []);

  useEffect(() => {
    pollProgress();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pollProgress]);

  async function handleStart() {
    const usernames = input
      .split(/[\n,\s]+/)
      .map((u) => u.trim().replace(/^@/, ""))
      .filter(Boolean);

    if (!usernames.length) return;

    setFilter("all");
    clear();

    const res = await fetch("/api/ig-ban-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames }),
    });

    if (res.ok) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(pollProgress, 1500);
      pollProgress();
    }
  }

  async function handleStop() {
    await fetch("/api/ig-ban-check", { method: "DELETE" });
    pollProgress();
  }

  function handleClear() {
    setInput("");
    setProgress(null);
    clear();
  }

  const results = progress?.results || [];
  const filtered =
    filter === "all" ? results : results.filter((r) => r.status === filter);

  // Keyed by username, not row index: the index silently re-pointed at other
  // accounts the moment a status filter was applied — tick five rows, click
  // "banned", and the ticks were now on five different people.
  const { selected, toggle, clear, toggleAll, allSelected } = useRowSelection(
    filtered.map((r) => r.username),
  );

  const selectedUsernames = () =>
    filtered.filter((r) => selected.has(r.username)).map((r) => r.username);

  function handleOpenSelected() {
    // No confirmation and no warning: the browser's own pop-up prompt is
    // the only gate worth having, and a dialog on top of it just adds a
    // click to something meant to be one click.
    openInstagramTabs(selectedUsernames());
  }

  function handleCopyUsernames() {
    navigator.clipboard.writeText(selectedUsernames().join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const pct = progress?.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  const estimateRemaining = () => {
    if (!progress?.running || !progress.total) return "";
    const remaining = progress.total - progress.completed;
    const seconds = Math.ceil(remaining * 0.5);
    if (seconds < 60) return `~${seconds}s`;
    const mins = Math.ceil(seconds / 60);
    return `~${mins}m`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Instagram Ban Checker</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste usernames to check which accounts are banned or alive.
          A ban is only confirmed after two separate profile checks; transient
          API errors are reported as &quot;inconclusive&quot; instead of banned.
        </p>
      </div>

      <div className="space-y-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste usernames here, separated by spaces, commas, or new lines...&#10;&#10;example1&#10;example2&#10;example3"
          className="w-full h-40 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          disabled={progress?.running}
        />
        <div className="flex items-center gap-2">
          <Button
            onClick={handleStart}
            disabled={progress?.running || !input.trim()}
          >
            {progress?.running ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Play className="mr-1.5 size-4" />
            )}
            {progress?.running
              ? `Checking ${progress.completed}/${progress.total}...`
              : "Start Check"}
          </Button>
          {progress?.running && (
            <Button variant="destructive" onClick={handleStop}>
              <Square className="mr-1.5 size-4" />
              Stop
            </Button>
          )}
          {results.length > 0 && !progress?.running && (
            <Button variant="outline" onClick={handleClear}>
              <Trash2 className="mr-1.5 size-4" />
              Clear Results
            </Button>
          )}
          <span className="text-xs text-muted-foreground ml-auto">
            {input.trim()
              ? `${input.split(/[\n,\s]+/).filter((u) => u.trim()).length} usernames`
              : ""}
          </span>
        </div>
      </div>

      {progress?.running && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>
              Checking{" "}
              <span className="font-mono font-medium">
                @{progress.current}
              </span>
              ...
            </span>
            <span className="text-muted-foreground">
              {progress.completed}/{progress.total} ({pct}%) — {estimateRemaining()} left
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex gap-4 text-sm">
            <span className="flex items-center gap-1 text-green-500">
              <ShieldCheck className="size-4" /> {progress.alive} alive
            </span>
            <span className="flex items-center gap-1 text-red-500">
              <ShieldAlert className="size-4" /> {progress.banned} banned
            </span>
            <span className="flex items-center gap-1 text-amber-500">
              <ShieldQuestion className="size-4" /> {progress.inconclusive} inconclusive
            </span>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {!progress?.running && (
              <div className="flex items-center gap-3 text-sm font-medium">
                <span className="flex items-center gap-1 text-green-500">
                  <ShieldCheck className="size-4" /> {progress?.alive ?? 0} alive
                </span>
                <span className="flex items-center gap-1 text-red-500">
                  <ShieldAlert className="size-4" /> {progress?.banned ?? 0} banned
                </span>
                <span className="flex items-center gap-1 text-amber-500">
                  <ShieldQuestion className="size-4" /> {progress?.inconclusive ?? 0} inconclusive
                </span>
                <span className="text-muted-foreground">
                  / {results.length} total
                </span>
              </div>
            )}

            <div className="flex items-center gap-1 ml-auto">
              {selected.size > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyUsernames}
                >
                  {copied ? (
                    <Check className="mr-1.5 size-4 text-green-500" />
                  ) : (
                    <Copy className="mr-1.5 size-4" />
                  )}
                  {copied
                    ? "Copied!"
                    : `Copy ${selected.size} username${selected.size === 1 ? "" : "s"}`}
                </Button>
              )}
              {selected.size > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleOpenSelected}
                  title="Opens one tab per account — the browser may ask you to allow pop-ups"
                >
                  <ExternalLink className="mr-1.5 size-4" />
                  Open {selected.size} in tabs
                </Button>
              )}
              {(["all", "alive", "banned", "inconclusive"] as FilterMode[]).map((f) => (
                <Button
                  key={f}
                  variant={filter === f ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setFilter(f);
                    clear();
                  }}
                >
                  {f === "all"
                    ? "All"
                    : f === "alive"
                      ? `Alive (${progress?.alive ?? 0})`
                      : f === "banned"
                        ? `Banned (${progress?.banned ?? 0})`
                        : `Inconclusive (${progress?.inconclusive ?? 0})`}
                </Button>
              ))}
            </div>
          </div>

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12 pl-4">
                    <label className="flex items-center justify-center cursor-pointer py-1 px-1">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        className="size-4 rounded border-border accent-primary cursor-pointer"
                      />
                    </label>
                  </TableHead>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead className="w-24">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((result, idx) => (
                  <TableRow key={`${result.username}-${idx}`}>
                    <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
                      <label className="flex items-center justify-center cursor-pointer py-2 px-1">
                        <input
                          type="checkbox"
                          checked={selected.has(result.username)}
                          // onClick, not onChange: only the click event carries
                          // shiftKey, which is what makes a range.
                          onChange={() => {}}
                          onClick={(e) => toggle(result.username, idx, e.shiftKey)}
                          className="size-4 rounded border-border accent-primary cursor-pointer"
                        />
                      </label>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {idx + 1}
                    </TableCell>
                    <TableCell>
                      <a
                        href={`https://www.instagram.com/${result.username}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-sm hover:underline"
                      >
                        @{result.username}
                      </a>
                    </TableCell>
                    <TableCell>
                      {result.status === "alive" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-500">
                          <ShieldCheck className="size-3" /> Alive
                        </span>
                      ) : result.status === "banned" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-500">
                          <ShieldAlert className="size-3" /> Banned
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-500">
                          <ShieldQuestion className="size-3" /> Inconclusive
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                      No accounts match this filter.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
