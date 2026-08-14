"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  TrendingDown,
  Minus,
  TrendingUp,
  HelpCircle,
  Loader2,
  Play,
  Copy,
  Check,
  Trash2,
  Square,
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
import {
  VIEWS_WINDOW,
  VIEW_BUCKET_ORDER,
  VIEW_BUCKET_LABEL,
  type ViewBucket,
} from "@/lib/view-buckets";

interface ViewsCheckResult {
  username: string;
  avgViews: number | null;
  videosCounted: number;
  bucket: ViewBucket;
  note?: string;
}

interface CheckProgress {
  total: number;
  completed: number;
  current: string | null;
  under100: number;
  mid: number;
  over200: number;
  nodata: number;
  running: boolean;
  results: ViewsCheckResult[];
}

type FilterMode = "all" | ViewBucket;

// Presentation only — the labels and ordering come from lib/view-buckets so
// the UI can never disagree with how the server bucketed a result.
const BUCKET_META: Record<
  ViewBucket,
  { icon: typeof TrendingDown; badgeCls: string; textCls: string }
> = {
  under100: {
    icon: TrendingDown,
    badgeCls: "bg-red-500/10 text-red-500",
    textCls: "text-red-500",
  },
  mid: {
    icon: Minus,
    badgeCls: "bg-amber-500/10 text-amber-500",
    textCls: "text-amber-500",
  },
  over200: {
    icon: TrendingUp,
    badgeCls: "bg-green-500/10 text-green-500",
    textCls: "text-green-500",
  },
  nodata: {
    icon: HelpCircle,
    badgeCls: "bg-zinc-500/20 text-zinc-300",
    textCls: "text-zinc-400",
  },
};

export function IgViewsCheckerPage() {
  const [input, setInput] = useState("");
  const [progress, setProgress] = useState<CheckProgress | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollProgress = useCallback(async () => {
    try {
      const res = await fetch("/api/ig-views-check", { cache: "no-store" });
      const data: CheckProgress = await res.json();
      setProgress(data);
      if (!data.running && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {}
  }, []);

  // Pick up a check that is still running from an earlier page visit.
  useEffect(() => {
    pollProgress().then(() => {});
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pollProgress]);

  useEffect(() => {
    if (progress?.running && !pollRef.current) {
      pollRef.current = setInterval(pollProgress, 1500);
    }
  }, [progress?.running, pollProgress]);

  async function handleStart() {
    const usernames = input
      .split(/[\n,\s]+/)
      .map((u) => u.trim().replace(/^@/, ""))
      .filter(Boolean);

    if (!usernames.length) return;

    setFilter("all");
    setSelected(new Set());

    const res = await fetch("/api/ig-views-check", {
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
    await fetch("/api/ig-views-check", { method: "DELETE" });
    pollProgress();
  }

  function handleClear() {
    setInput("");
    setProgress(null);
    setSelected(new Set());
  }

  const results = progress?.results || [];

  // Worst first — the whole point of the screen is spotting the weak accounts.
  // "No data" rows sink to the bottom since they carry no number.
  const sorted = [...results].sort((a, b) => {
    if (a.avgViews === null && b.avgViews === null) return 0;
    if (a.avgViews === null) return 1;
    if (b.avgViews === null) return -1;
    return a.avgViews - b.avgViews;
  });
  const filtered = filter === "all" ? sorted : sorted.filter((r) => r.bucket === filter);

  function bucketCount(b: ViewBucket): number {
    if (!progress) return 0;
    return b === "under100"
      ? progress.under100
      : b === "mid"
        ? progress.mid
        : b === "over200"
          ? progress.over200
          : progress.nodata;
  }

  function toggleSelect(username: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  }

  function toggleSelectAll() {
    if (filtered.every((r) => selected.has(r.username)) && filtered.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((r) => r.username)));
    }
  }

  function handleCopySelected() {
    const usernames = filtered
      .filter((r) => selected.has(r.username))
      .map((r) => r.username)
      .join("\n");
    navigator.clipboard.writeText(usernames);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const pct = progress?.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  // ~3.5s per account across 3 workers (36 reels = 3 paged API calls each).
  const estimateRemaining = () => {
    if (!progress?.running || !progress.total) return "";
    const remaining = progress.total - progress.completed;
    const seconds = Math.ceil((remaining * 3.5) / 3);
    if (seconds < 60) return `~${seconds}s`;
    return `~${Math.ceil(seconds / 60)}m`;
  };

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Views Checker</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste usernames to grade them by the average views of their last{" "}
          {VIEWS_WINDOW} reels — the same window the tracker shows as &quot;Avg
          (last {VIEWS_WINDOW})&quot;. Accounts do not need to be in the tracker;
          each one is scraped live (~3 API calls, a few seconds per account).
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
          <Button onClick={handleStart} disabled={progress?.running || !input.trim()}>
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
              <span className="font-mono font-medium">@{progress.current}</span>...
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
        </div>
      )}

      {/* Bucket summary — the answer the screen exists to give */}
      {results.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {VIEW_BUCKET_ORDER.map((b) => {
            const meta = BUCKET_META[b];
            const Icon = meta.icon;
            return (
              <button
                key={b}
                onClick={() => {
                  setFilter(filter === b ? "all" : b);
                  setSelected(new Set());
                }}
                className={`rounded-lg border p-4 text-left transition-colors ${
                  filter === b
                    ? "border-primary/50 bg-primary/5"
                    : "border-border bg-card hover:bg-accent/40"
                }`}
              >
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon className={`size-3.5 ${meta.textCls}`} />
                  {VIEW_BUCKET_LABEL[b]}
                </p>
                <p className={`text-2xl font-bold ${meta.textCls}`}>{bucketCount(b)}</p>
              </button>
            );
          })}
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {filtered.length} shown / {results.length} checked
            </span>

            <div className="flex items-center gap-1 ml-auto">
              {selected.size > 0 && (
                <Button variant="outline" size="sm" onClick={handleCopySelected}>
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
              <Button
                variant={filter === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setFilter("all");
                  setSelected(new Set());
                }}
              >
                All ({results.length})
              </Button>
              {VIEW_BUCKET_ORDER.map((b) => (
                <Button
                  key={b}
                  variant={filter === b ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setFilter(b);
                    setSelected(new Set());
                  }}
                >
                  {VIEW_BUCKET_LABEL[b]} ({bucketCount(b)})
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
                        checked={
                          filtered.length > 0 &&
                          filtered.every((r) => selected.has(r.username))
                        }
                        onChange={toggleSelectAll}
                        className="size-4 rounded border-border accent-primary cursor-pointer"
                      />
                    </label>
                  </TableHead>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead className="text-right w-28">Avg views</TableHead>
                  <TableHead className="text-right w-20">Videos</TableHead>
                  <TableHead className="w-32">Bucket</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((result, idx) => {
                  const meta = BUCKET_META[result.bucket];
                  const Icon = meta.icon;
                  return (
                    <TableRow key={result.username}>
                      <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
                        <label className="flex items-center justify-center cursor-pointer py-2 px-1">
                          <input
                            type="checkbox"
                            checked={selected.has(result.username)}
                            onChange={() => toggleSelect(result.username)}
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
                        {result.note && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {result.note}
                          </p>
                        )}
                      </TableCell>
                      <TableCell
                        className={`text-right font-semibold tabular-nums ${meta.textCls}`}
                      >
                        {result.avgViews === null ? "—" : formatNumber(result.avgViews)}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                        {result.videosCounted || "—"}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.badgeCls}`}
                        >
                          <Icon className="size-3" /> {VIEW_BUCKET_LABEL[result.bucket]}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
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
