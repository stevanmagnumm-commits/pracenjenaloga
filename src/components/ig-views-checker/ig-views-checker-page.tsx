"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  TrendingDown,
  Minus,
  TrendingUp,
  HelpCircle,
  Ban,
  ArrowUp,
  ArrowDown,
  Inbox,
  ImageOff,
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
  counts: Record<ViewBucket, number>;
  phase: "idle" | "checking" | "confirming" | "done";
  pending: number;
  running: boolean;
  results: ViewsCheckResult[];
}

type FilterMode = "all" | ViewBucket;
type SortKey = "avg" | "videos" | "bucket";

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
  banned: {
    icon: Ban,
    badgeCls: "bg-rose-600/15 text-rose-400",
    textCls: "text-rose-400",
  },
  noposts: {
    icon: Inbox,
    badgeCls: "bg-slate-500/15 text-slate-400",
    textCls: "text-slate-400",
  },
  noreels: {
    icon: ImageOff,
    badgeCls: "bg-sky-500/10 text-sky-400",
    textCls: "text-sky-400",
  },
  failed: {
    icon: HelpCircle,
    badgeCls: "bg-zinc-500/20 text-zinc-300",
    textCls: "text-zinc-400",
  },
};

/** Arrow on a sortable header: filled on the active column, faint otherwise. */
function SortMark({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  const Icon = dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <Icon
      className={`size-3 ${active ? "opacity-100" : "opacity-25"}`}
      aria-hidden
    />
  );
}

export function IgViewsCheckerPage() {
  const [input, setInput] = useState("");
  const [progress, setProgress] = useState<CheckProgress | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("avg");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clicking the active column flips direction; a new column starts ascending,
  // which keeps the default "worst first" reading of the screen.
  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

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

  // Worst first by default — the whole point of the screen is spotting the weak
  // accounts. Ungraded rows (banned / no posts / no reels / failed) carry no
  // number, so they always sink to the bottom whichever way the sort points;
  // floating them to the top on a descending sort would just bury the data.
  const sorted = [...results].sort((a, b) => {
    // Sorting by bucket groups the ungraded rows together — the way to pull all
    // the banned accounts into one block — so it ranks every row and returns
    // early, unlike the numeric sorts below.
    if (sortKey === "bucket") {
      const d =
        VIEW_BUCKET_ORDER.indexOf(a.bucket) - VIEW_BUCKET_ORDER.indexOf(b.bucket);
      if (d !== 0) return sortDir === "asc" ? d : -d;
      return (b.avgViews ?? -1) - (a.avgViews ?? -1);
    }
    const av = sortKey === "avg" ? a.avgViews : a.videosCounted || null;
    const bv = sortKey === "avg" ? b.avgViews : b.videosCounted || null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return sortDir === "asc" ? av - bv : bv - av;
  });
  const filtered = filter === "all" ? sorted : sorted.filter((r) => r.bucket === filter);

  function bucketCount(b: ViewBucket): number {
    return progress?.counts?.[b] ?? 0;
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

  // Two passes run at very different speeds, so the estimate has to know which
  // one it is in. Pass 1 is six accounts at a time, ~3.5s each. Pass 2 walks
  // them one at a time with a recheck in between — call it 15s per account.
  const estimateRemaining = () => {
    if (!progress?.running || !progress.total) return "";
    const remaining = progress.total - progress.completed;
    const seconds =
      progress.phase === "confirming"
        ? remaining * 15
        : Math.ceil(((remaining - progress.pending) * 3.5) / 6 + progress.pending * 15);
    if (seconds < 60) return `~${seconds}s`;
    return `~${Math.ceil(seconds / 60)}m`;
  };

  // Pass 2 deliberately crawls: one account at a time, the same pace the Ban
  // Checker uses. Probing these in parallel is what made half the "banned"
  // verdicts wrong, so the slowness is the point — say so, or it reads as a
  // stall and someone stops the run right before the answers arrive.
  const phaseLabel =
    progress?.phase === "confirming"
      ? `Confirming ${progress.pending} possible bans one at a time — slow on purpose, parallel checks produce false bans`
      : progress?.pending
        ? `${progress.pending} parked for the slow confirmation pass`
        : "";

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Views Checker</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste usernames to grade them by the average views of their last{" "}
          {VIEWS_WINDOW} reels, pinned posts excluded — the same window the
          tracker shows as &quot;Avg (last {VIEWS_WINDOW})&quot;. Accounts do not
          need to be in the tracker; each one is scraped live. Click the Avg
          views, Videos or Bucket headers to sort.
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
          {phaseLabel && (
            <p className="text-xs text-muted-foreground">{phaseLabel}</p>
          )}
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
                  <TableHead className="text-right w-28">
                    <button
                      type="button"
                      onClick={() => toggleSort("avg")}
                      className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                    >
                      Avg views
                      <SortMark active={sortKey === "avg"} dir={sortDir} />
                    </button>
                  </TableHead>
                  <TableHead className="text-right w-20">
                    <button
                      type="button"
                      onClick={() => toggleSort("videos")}
                      className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                    >
                      Videos
                      <SortMark active={sortKey === "videos"} dir={sortDir} />
                    </button>
                  </TableHead>
                  <TableHead className="w-32">
                    <button
                      type="button"
                      onClick={() => toggleSort("bucket")}
                      className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                    >
                      Bucket
                      <SortMark active={sortKey === "bucket"} dir={sortDir} />
                    </button>
                  </TableHead>
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
