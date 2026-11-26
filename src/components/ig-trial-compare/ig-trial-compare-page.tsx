"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  ExternalLink,
  HelpCircle,
  Loader2,
  Minus,
  Play,
  Square,
  Trash2,
  TrendingDown,
  TrendingUp,
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
import { useRowSelection } from "@/lib/use-row-selection";
import { formatNumber } from "@/lib/utils";
import {
  ORGANIC_WINDOW,
  TRIAL_BUCKET_LABEL,
  TRIAL_BUCKET_ORDER,
  TRIAL_SAME_BAND,
  type TrialBucket,
} from "@/lib/trial-buckets";

interface TrialReelRow {
  shortcode: string;
  url: string;
  views: number | null;
  note: string;
}

interface OrganicReelRow {
  shortcode: string;
  views: number;
}

interface TrialCompareResult {
  username: string;
  trialAvg: number | null;
  trialCount: number;
  organicAvg: number | null;
  organicCount: number;
  diffPct: number | null;
  bucket: TrialBucket;
  note?: string;
  reels: TrialReelRow[];
  organic: OrganicReelRow[];
}

interface Progress {
  total: number;
  /** Reels whose owner and view count are settled — the first pass. */
  resolved: number;
  completed: number;
  current: string | null;
  phase: "idle" | "resolving" | "comparing" | "done";
  running: boolean;
  counts: Record<TrialBucket, number>;
  results: TrialCompareResult[];
  abortedReason: string | null;
  rate: { used: number; limit: number };
  perReel?: { remaining: number; limit: number } | null;
  lane?: { used: number; ceiling: number | null; heldBy: string | null };
}

type FilterMode = "all" | TrialBucket;
type SortKey = "diff" | "trial" | "organic" | "bucket";

// Presentation only. Which bucket a row is in is decided on the server, in
// lib/trial-buckets.ts, so the two can never disagree.
const BUCKET_META: Record<
  TrialBucket,
  { icon: typeof TrendingDown; badgeCls: string; textCls: string }
> = {
  worse: {
    icon: TrendingDown,
    badgeCls: "bg-red-500/10 text-red-500",
    textCls: "text-red-500",
  },
  same: {
    icon: Minus,
    badgeCls: "bg-amber-500/10 text-amber-500",
    textCls: "text-amber-500",
  },
  better: {
    icon: TrendingUp,
    badgeCls: "bg-green-500/10 text-green-500",
    textCls: "text-green-500",
  },
  failed: {
    icon: HelpCircle,
    badgeCls: "bg-slate-500/15 text-slate-400",
    textCls: "text-slate-400",
  },
};

function signed(pct: number): string {
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

export function IgTrialComparePage() {
  const [input, setInput] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [sortKey, setSortKey] = useState<SortKey>("diff");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<"names" | "links" | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [startError, setStartError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollProgress = useCallback(async () => {
    try {
      const res = await fetch("/api/ig-trial-compare", { cache: "no-store" });
      const data: Progress = await res.json();
      setProgress(data);
      if (!data.running && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {}
  }, []);

  // Pick up a run that is still going from an earlier page visit.
  useEffect(() => {
    void pollProgress();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pollProgress]);

  useEffect(() => {
    if (progress?.running && !pollRef.current) {
      pollRef.current = setInterval(pollProgress, 1500);
    }
  }, [progress?.running, pollProgress]);

  const results = progress?.results || [];

  const sorted = [...results].sort((a, b) => {
    if (sortKey === "bucket") {
      const d =
        TRIAL_BUCKET_ORDER.indexOf(a.bucket) - TRIAL_BUCKET_ORDER.indexOf(b.bucket);
      if (d !== 0) return sortDir === "asc" ? d : -d;
      return (b.diffPct ?? -9999) - (a.diffPct ?? -9999);
    }
    const pick = (r: TrialCompareResult) =>
      sortKey === "diff"
        ? r.diffPct
        : sortKey === "trial"
          ? r.trialAvg
          : r.organicAvg;
    const av = pick(a);
    const bv = pick(b);
    // A row with no number sinks either way. Floating the unreadable rows to
    // the top on a descending sort would bury the actual findings.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return sortDir === "asc" ? av - bv : bv - av;
  });

  const filtered =
    filter === "all" ? sorted : sorted.filter((r) => r.bucket === filter);

  const { selected, toggle, clear, toggleAll, allSelected } = useRowSelection(
    filtered.map((r) => r.username),
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function toggleOpen(username: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  }

  const selectedRows = () => filtered.filter((r) => selected.has(r.username));

  function copyOut(lines: string[], which: "names" | "links") {
    navigator.clipboard.writeText(lines.join("\n"));
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
  }

  const names = () => selectedRows().map((r) => r.username);
  const links = () =>
    selectedRows().flatMap((r) => r.reels.map((x) => x.url));

  async function handleStart() {
    setFilter("all");
    clear();
    setSkipped([]);
    setStartError(null);
    setOpen(new Set());

    const lines = input.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return;

    const res = await fetch("/api/ig-trial-compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reelLines: lines }),
    });
    const answer = (await res.json().catch(() => null)) as
      | { error?: string; skippedLines?: string[] }
      | null;
    if (answer?.skippedLines?.length) setSkipped(answer.skippedLines);
    if (!res.ok) {
      setStartError(answer?.error || `Could not start (HTTP ${res.status})`);
      return;
    }
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(pollProgress, 1500);
    void pollProgress();
  }

  async function handleStop() {
    await fetch("/api/ig-trial-compare", { method: "DELETE" });
    void pollProgress();
  }

  function handleClear() {
    setInput("");
    setProgress(null);
    setSkipped([]);
    setStartError(null);
    setOpen(new Set());
    clear();
  }

  // Both passes, half the bar each. Tracking only the second one left the bar
  // at zero through the whole of the first, which on a long paste is most of
  // the run and reads as a freeze.
  const pct = progress?.total
    ? Math.round(
        ((progress.resolved + progress.completed) / (progress.total * 2)) * 100,
      )
    : 0;

  const lineCount = input.split(/\r?\n/).filter((l) => l.trim()).length;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Trial vs Organic</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste trial reel links, one per line — nothing else. The account is
          read off the reel itself, so no username has to be typed and a typo
          cannot send the comparison to the wrong profile. Each row is one
          account: the average of its trial reels, the average of its last{" "}
          {ORGANIC_WINDOW} organic reels (pinned excluded, and any pasted reel
          taken out of the baseline), and the gap between them in percent.
          Several trial reels of the same account are averaged into one row.
          You may still put a username in front of a URL — it is used as a hint
          for where to look first, and the reel always has the last word.
        </p>
      </div>

      <div className="space-y-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          // Real newlines. The sibling screen writes &#10; here, which only
          // works in JSX text - inside a string expression it reaches the
          // browser as the five characters you are reading.
          placeholder={
            "One trial reel link per line:\n\n" +
            "https://www.instagram.com/reel/ABCdefGHijk/\n" +
            "https://www.instagram.com/reel/LMNopQRstuv/\n" +
            "https://www.instagram.com/reel/WXYz01234ab/"
          }
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
              ? `Working ${progress.resolved + progress.completed}/${progress.total * 2}...`
              : "Compare"}
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
            {lineCount ? `${lineCount} lines` : ""}
          </span>
        </div>
      </div>

      {startError && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {startError}
        </div>
      )}

      {skipped.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
          <span className="font-medium text-amber-400">
            {skipped.length} line{skipped.length === 1 ? "" : "s"} had no reel URL
          </span>{" "}
          and {skipped.length === 1 ? "was" : "were"} not checked:
          <ul className="mt-1 font-mono text-xs text-muted-foreground">
            {skipped.slice(0, 8).map((l) => (
              <li key={l}>{l}</li>
            ))}
            {skipped.length > 8 && <li>…and {skipped.length - 8} more</li>}
          </ul>
        </div>
      )}

      {progress?.abortedReason && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <span className="font-semibold">Run stopped.</span>{" "}
          {progress.abortedReason}
        </div>
      )}

      {progress?.perReel && (
        <p className="text-xs text-muted-foreground">
          Per-reel lookups left this month:{" "}
          <span className="font-medium text-foreground">
            {progress.perReel.remaining.toLocaleString("en-US")}
          </span>{" "}
          of {progress.perReel.limit.toLocaleString("en-US")} — one per trial
          reel, since a trial reel is not on the profile and only this plan can
          read it. The organic baseline comes off the other plan and costs one
          call per account however many of its reels you paste.
        </p>
      )}

      {progress?.running && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {progress.phase === "resolving"
                ? `Reading the reels and who they belong to — ${progress.resolved}/${progress.total}`
                : progress.current
                  ? `Comparing @${progress.current}…`
                  : "Working…"}
            </span>
            <span className="text-muted-foreground">
              {progress.phase === "resolving"
                ? `${progress.resolved}/${progress.total} reels`
                : `${progress.completed}/${progress.total} reels compared`}{" "}
              ({pct}%)
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          {progress.lane?.ceiling != null && (
            <p className="text-xs text-amber-400">
              Running on a share of the API budget ({progress.lane.ceiling}{" "}
              calls/min) because the {progress.lane.heldBy} is working. Slower,
              not stuck.
            </p>
          )}
        </div>
      )}

      {results.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TRIAL_BUCKET_ORDER.map((b) => {
            const Meta = BUCKET_META[b];
            const Icon = Meta.icon;
            return (
              <button
                key={b}
                type="button"
                onClick={() => {
                  setFilter(filter === b ? "all" : b);
                  clear();
                }}
                className={`rounded-lg border p-4 text-left transition-colors ${
                  filter === b
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40"
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon className={`size-3.5 ${Meta.textCls}`} />
                  {TRIAL_BUCKET_LABEL[b]}
                </div>
                <div className={`mt-1 text-2xl font-bold ${Meta.textCls}`}>
                  {progress?.counts?.[b] ?? 0}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {filtered.length} shown / {results.length} accounts
            </span>
            <div className="ml-auto flex items-center gap-1">
              {selected.size > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyOut(names(), "names")}
                  title="Usernames only, one per line"
                >
                  {copied === "names" ? (
                    <Check className="mr-1.5 size-4 text-green-500" />
                  ) : (
                    <Copy className="mr-1.5 size-4" />
                  )}
                  {copied === "names"
                    ? "Copied!"
                    : `Copy ${names().length} username${names().length === 1 ? "" : "s"}`}
                </Button>
              )}
              {selected.size > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyOut(links(), "links")}
                  title="Every trial reel link of the selected accounts"
                >
                  {copied === "links" ? (
                    <Check className="mr-1.5 size-4 text-green-500" />
                  ) : (
                    <ExternalLink className="mr-1.5 size-4" />
                  )}
                  {copied === "links"
                    ? "Copied!"
                    : `Copy ${links().length} link${links().length === 1 ? "" : "s"}`}
                </Button>
              )}
              <Button
                variant={filter === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setFilter("all");
                  clear();
                }}
              >
                All ({results.length})
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="size-4 cursor-pointer"
                    />
                  </TableHead>
                  <TableHead className="w-8" />
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead
                    className="cursor-pointer text-right select-none"
                    onClick={() => toggleSort("trial")}
                  >
                    Trial avg
                    {sortKey === "trial" &&
                      (sortDir === "asc" ? (
                        <ArrowUp className="ml-1 inline size-3" />
                      ) : (
                        <ArrowDown className="ml-1 inline size-3" />
                      ))}
                  </TableHead>
                  <TableHead
                    className="cursor-pointer text-right select-none"
                    onClick={() => toggleSort("organic")}
                  >
                    Organic avg ({ORGANIC_WINDOW})
                    {sortKey === "organic" &&
                      (sortDir === "asc" ? (
                        <ArrowUp className="ml-1 inline size-3" />
                      ) : (
                        <ArrowDown className="ml-1 inline size-3" />
                      ))}
                  </TableHead>
                  <TableHead
                    className="cursor-pointer text-right select-none"
                    onClick={() => toggleSort("diff")}
                  >
                    Trial vs organic
                    {sortKey === "diff" &&
                      (sortDir === "asc" ? (
                        <ArrowUp className="ml-1 inline size-3" />
                      ) : (
                        <ArrowDown className="ml-1 inline size-3" />
                      ))}
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort("bucket")}
                  >
                    Verdict
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r, i) => {
                  const Meta = BUCKET_META[r.bucket];
                  const Icon = Meta.icon;
                  const isOpen = open.has(r.username);
                  return (
                    // Fragment, not <>, because this one needs a key: each
                    // account renders two sibling rows and React has to be
                    // able to tell one account's pair from another's.
                    <Fragment key={r.username}>
                      <TableRow>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={selected.has(r.username)}
                            onChange={(e) =>
                              toggle(
                                r.username,
                                i,
                                (e.nativeEvent as MouseEvent).shiftKey,
                              )
                            }
                            className="size-4 cursor-pointer"
                          />
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            onClick={() => toggleOpen(r.username)}
                            className="text-muted-foreground hover:text-foreground"
                            title="Show the individual reels this row is made of"
                          >
                            {isOpen ? (
                              <ChevronDown className="size-4" />
                            ) : (
                              <ChevronRight className="size-4" />
                            )}
                          </button>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {i + 1}
                        </TableCell>
                        <TableCell>
                          <a
                            href={`https://www.instagram.com/${r.username}/`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium hover:underline"
                          >
                            @{r.username}
                          </a>
                          <div className="text-xs text-muted-foreground">
                            {r.trialCount} trial reel
                            {r.trialCount === 1 ? "" : "s"} vs {r.organicCount}{" "}
                            organic
                            {r.note ? ` — ${r.note}` : ""}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {r.trialAvg === null ? "—" : formatNumber(r.trialAvg)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {r.organicAvg === null
                            ? "—"
                            : formatNumber(r.organicAvg)}
                        </TableCell>
                        <TableCell
                          className={`text-right text-base font-bold ${Meta.textCls}`}
                        >
                          {r.diffPct === null ? "—" : signed(r.diffPct)}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${Meta.badgeCls}`}
                          >
                            <Icon className="size-3" />
                            {TRIAL_BUCKET_LABEL[r.bucket]}
                          </span>
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow>
                          <TableCell colSpan={8} className="bg-muted/30">
                            <div className="grid gap-6 py-2 md:grid-cols-2">
                              <div>
                                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  Trial reels
                                </div>
                                <ul className="space-y-1 text-sm">
                                  {r.reels.map((x) => (
                                    <li
                                      key={x.shortcode}
                                      className="flex items-baseline gap-2"
                                    >
                                      <a
                                        href={x.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="font-mono text-xs hover:underline"
                                      >
                                        /{x.shortcode}
                                      </a>
                                      <span className="font-medium">
                                        {x.views === null
                                          ? "—"
                                          : formatNumber(x.views)}
                                      </span>
                                      <span className="text-xs text-muted-foreground">
                                        {x.note}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                              <div>
                                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  Organic baseline (last {ORGANIC_WINDOW})
                                </div>
                                {r.organic.length === 0 ? (
                                  <p className="text-sm text-muted-foreground">
                                    nothing on the profile to compare against
                                  </p>
                                ) : (
                                  <ul className="space-y-1 text-sm">
                                    {r.organic.map((o) => (
                                      <li
                                        key={o.shortcode}
                                        className="flex items-baseline gap-2"
                                      >
                                        <a
                                          href={`https://www.instagram.com/reel/${o.shortcode}/`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="font-mono text-xs hover:underline"
                                        >
                                          /{o.shortcode}
                                        </a>
                                        <span className="font-medium">
                                          {formatNumber(o.views)}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <p className="text-xs text-muted-foreground">
            A verdict is only a colour: anything within ±{TRIAL_SAME_BAND}% is
            called the same, because view counts on one account swing about that
            much between two ordinary posts. The exact percentage is in the
            column beside it.
          </p>
        </div>
      )}
    </div>
  );
}
