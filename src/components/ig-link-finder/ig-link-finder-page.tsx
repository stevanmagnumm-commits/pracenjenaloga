"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Link2,
  Sparkles,
  MessageSquareText,
  Tag,
  ExternalLink,
  Download,
  CircleSlash,
  Lock,
  HelpCircle,
  Loader2,
  Play,
  Copy,
  Check,
  Trash2,
  Square,
  BadgeCheck,
  UserMinus,
  Languages,
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

type LinkBucket =
  | "bio"
  | "signal"
  | "hlname"
  | "story"
  | "outofrange"
  | "wrongscript"
  | "none"
  | "private"
  | "failed";

interface FinderResult {
  username: string;
  fullName: string;
  bucket: LinkBucket;
  seed: string;
  bioLinks: string[];
  storyLinks: string[];
  linkHosts: string[];
  biography: string;
  bioSignals: string[];
  followers: number;
  highlightTitles: string[];
  isVerified: boolean;
  isPrivate: boolean;
  note?: string;
}

interface FinderProgress {
  total: number;
  completed: number;
  current: string | null;
  phase: "idle" | "suggesting" | "checking" | "done";
  seedsDone: number;
  seedsTotal: number;
  counts: Record<LinkBucket, number>;
  abortedReason: string | null;
  running: boolean;
  results: FinderResult[];
}

const BUCKET_ORDER: LinkBucket[] = [
  "bio",
  "signal",
  "hlname",
  "story",
  "outofrange",
  "wrongscript",
  "none",
  "private",
  "failed",
];

const BUCKET_META: Record<
  LinkBucket,
  { label: string; icon: typeof Link2; badgeCls: string; textCls: string }
> = {
  bio: {
    label: "Link in bio",
    icon: Link2,
    badgeCls: "bg-green-500/10 text-green-500",
    textCls: "text-green-500",
  },
  signal: {
    label: "Bio says so",
    icon: MessageSquareText,
    badgeCls: "bg-amber-500/10 text-amber-400",
    textCls: "text-amber-400",
  },
  hlname: {
    label: "Highlight says so",
    icon: Tag,
    badgeCls: "bg-orange-500/10 text-orange-400",
    textCls: "text-orange-400",
  },
  story: {
    label: "Link in highlight",
    icon: Sparkles,
    badgeCls: "bg-violet-500/10 text-violet-400",
    textCls: "text-violet-400",
  },
  outofrange: {
    label: "Out of range",
    icon: UserMinus,
    badgeCls: "bg-zinc-500/15 text-zinc-500",
    textCls: "text-zinc-500",
  },
  wrongscript: {
    label: "Foreign script",
    icon: Languages,
    badgeCls: "bg-zinc-500/15 text-zinc-500",
    textCls: "text-zinc-500",
  },
  none: {
    label: "No link",
    icon: CircleSlash,
    badgeCls: "bg-zinc-500/15 text-zinc-400",
    textCls: "text-zinc-400",
  },
  private: {
    label: "Private",
    icon: Lock,
    badgeCls: "bg-amber-500/10 text-amber-500",
    textCls: "text-amber-500",
  },
  failed: {
    label: "Check failed",
    icon: HelpCircle,
    badgeCls: "bg-zinc-500/20 text-zinc-300",
    textCls: "text-zinc-400",
  },
};

export function IgLinkFinderPage() {
  const [input, setInput] = useState("");
  const [checkHighlights, setCheckHighlights] = useState(true);
  const [progress, setProgress] = useState<FinderProgress | null>(null);
  const [filter, setFilter] = useState<"all" | LinkBucket>("all");
  const [copied, setCopied] = useState(false);
  // Collecting is expensive, filtering is free — so every criterion is applied
  // here, over results already in hand, and can be changed without re-scraping.
  const [query, setQuery] = useState("");
  const [host, setHost] = useState("");
  const [minFollowers, setMinFollowers] = useState("");
  const [onlySignal, setOnlySignal] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollProgress = useCallback(async () => {
    try {
      const res = await fetch("/api/ig-link-finder", { cache: "no-store" });
      const data: FinderProgress = await res.json();
      setProgress(data);
      if (!data.running && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {}
  }, []);

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
    const seeds = input
      .split(/[\n,\s]+/)
      .map((u) => u.trim().replace(/^@/, ""))
      .filter(Boolean);
    if (!seeds.length) return;

    setFilter("all");
    clear();

    const res = await fetch("/api/ig-link-finder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seeds, checkHighlights }),
    });
    if (res.ok) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(pollProgress, 1500);
      pollProgress();
    }
  }

  async function handleStop() {
    await fetch("/api/ig-link-finder", { method: "DELETE" });
    pollProgress();
  }

  function handleClear() {
    setInput("");
    setProgress(null);
    clear();
  }

  const results = progress?.results || [];
  // Accounts that are actually running a link come first — that is the answer
  // the screen exists to give.
  const sorted = [...results].sort(
    (a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket),
  );
  const byBucket = filter === "all" ? sorted : sorted.filter((r) => r.bucket === filter);

  // One box searches everything that can identify a funnel: the handle, the
  // display name, the bio text, the link itself and the highlight titles.
  const needle = query.trim().toLowerCase();
  const minF = Number(minFollowers) || 0;
  const filtered = byBucket.filter((r) => {
    if (onlySignal && !r.bioSignals.length) return false;
    if (minF && r.followers < minF) return false;
    if (host && !r.linkHosts.some((h) => h.includes(host.toLowerCase()))) return false;
    if (!needle) return true;
    const haystack = [
      r.username,
      r.fullName,
      r.biography,
      ...r.bioLinks,
      ...r.storyLinks,
      ...r.highlightTitles,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });

  // Hosts actually present in the results, most common first — this is the
  // "who funnels where" summary, and doubles as the filter's vocabulary.
  const hostCounts = new Map<string, number>();
  for (const r of sorted) {
    for (const h of r.linkHosts) hostCounts.set(h, (hostCounts.get(h) || 0) + 1);
  }
  const topHosts = [...hostCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const signalCount = sorted.filter((r) => r.bioSignals.length).length;

  const { selected, toggle, clear, toggleAll, allSelected } = useRowSelection(
    filtered.map((r) => r.username),
  );

  function bucketCount(b: LinkBucket): number {
    return progress?.counts?.[b] ?? 0;
  }

  const selectedUsernames = () =>
    filtered.filter((r) => selected.has(r.username)).map((r) => r.username);

  function handleCopySelected() {
    navigator.clipboard.writeText(selectedUsernames().join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Every bucket that means "this account is running a funnel", regardless of
  // which check proved it.
  const GOOD: LinkBucket[] = ["bio", "signal", "hlname", "story"];
  const goodResults = sorted.filter((r) => GOOD.includes(r.bucket));

  function handleDownloadGood() {
    if (!goodResults.length) return;
    // CRLF, because these lists get opened in Notepad and pasted into Excel.
    const nl = "\r\n";
    const text = goodResults.map((r) => r.username).join(nl) + nl;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `link-finder-${stamp}-${goodResults.length}-accounts.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleOpenSelected() {
    // No confirmation and no warning: the browser's own pop-up prompt is
    // the only gate worth having, and a dialog on top of it just adds a
    // click to something meant to be one click.
    openInstagramTabs(selectedUsernames());
  }

  const pct = progress?.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  const phaseLabel =
    progress?.phase === "suggesting"
      ? `Collecting suggestions — seed ${progress.seedsDone}/${progress.seedsTotal}`
      : progress?.phase === "checking" && checkHighlights
        ? "Bio first; highlights only for accounts whose bio is empty"
        : "";

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Link Finder</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste one or more seed accounts. Instagram&apos;s own &quot;similar
          accounts&quot; list is pulled for each (~80 per seed), then every
          suggestion is checked for a link — in the bio, or on a link sticker
          saved into a story highlight.
        </p>
      </div>

      <div className="space-y-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Seed accounts, one per line...&#10;&#10;gymshark&#10;aloyoga"
          className="w-full h-32 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          disabled={progress?.running}
        />

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={checkHighlights}
            onChange={(e) => setCheckHighlights(e.target.checked)}
            disabled={progress?.running}
            className="size-4 accent-violet-500"
          />
          Also check story highlights for link stickers
          <span className="text-xs">
            (slower and costs several API calls per account — only spent where the bio is empty)
          </span>
        </label>

        <div className="flex items-center gap-2">
          <Button onClick={handleStart} disabled={progress?.running || !input.trim()}>
            {progress?.running ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Searching...
              </>
            ) : (
              <>
                <Play className="size-4" /> Find links
              </>
            )}
          </Button>
          {progress?.running && (
            <Button variant="outline" onClick={handleStop}>
              <Square className="size-4" /> Stop
            </Button>
          )}
          <Button variant="ghost" onClick={handleClear} disabled={progress?.running}>
            <Trash2 className="size-4" /> Clear
          </Button>
        </div>
      </div>

      {progress?.abortedReason && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <span className="font-semibold">Run stopped.</span> {progress.abortedReason}
        </div>
      )}

      {progress?.running && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>
              Checking <span className="font-mono font-medium">@{progress.current}</span>...
            </span>
            <span className="text-muted-foreground">
              {progress.completed}/{progress.total} ({pct}%)
            </span>
          </div>
          {phaseLabel && <p className="text-xs text-muted-foreground">{phaseLabel}</p>}
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {progress && progress.results.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
            {BUCKET_ORDER.map((b) => {
              const meta = BUCKET_META[b];
              const Icon = meta.icon;
              return (
                <button
                  key={b}
                  onClick={() => setFilter(filter === b ? "all" : b)}
                  className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                    filter === b ? "border-primary" : "border-border hover:border-muted-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Icon className="size-3.5" />
                    {meta.label}
                  </div>
                  <p className={`text-2xl font-bold ${meta.textCls}`}>{bucketCount(b)}</p>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search bio, handle, link, highlight title..."
              className="h-9 w-72 rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="Link host (e.g. onlyfans)"
              className="h-9 w-52 rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              value={minFollowers}
              onChange={(e) => setMinFollowers(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="Min followers"
              className="h-9 w-36 rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              onClick={() => setOnlySignal(!onlySignal)}
              className={`h-9 rounded-md border px-3 text-sm transition-colors ${
                onlySignal
                  ? "border-amber-500 text-amber-400"
                  : "border-border text-muted-foreground hover:border-muted-foreground"
              }`}
              title='Bio says where the link is — "check my highlights", "only backup", "main", an arrow'
            >
              Bio signal <span className="opacity-60">{signalCount}</span>
            </button>
            <span className="text-sm text-muted-foreground">
              {filtered.length} of {sorted.length}
            </span>
          </div>

          {topHosts.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Where they link:</span>
              {topHosts.map(([h, n]) => (
                <button
                  key={h}
                  onClick={() => setHost(host === h ? "" : h)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    host === h
                      ? "border-primary text-primary"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  }`}
                >
                  {h} <span className="opacity-60">{n}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={handleDownloadGood}
              disabled={!goodResults.length}
              title="Every account with a link — in bio, in a highlight, or announced in the bio or a highlight name"
            >
              <Download className="size-4" />
              Download {goodResults.length} good
            </Button>
            <Button variant="outline" size="sm" onClick={toggleAll}>
              {allSelected ? "Deselect all" : "Select all shown"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopySelected}
              disabled={!selected.size}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              Copy {selected.size || ""} usernames
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenSelected}
              disabled={!selected.size}
              title="Opens one tab per account — the browser may ask you to allow pop-ups"
            >
              <ExternalLink className="size-4" />
              Open {selected.size || ""} in tabs
            </Button>
            {filter !== "all" && (
              <Button variant="ghost" size="sm" onClick={() => setFilter("all")}>
                Show all
              </Button>
            )}
          </div>

          <div className="rounded-lg border border-border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12 pl-4">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="size-4"
                    />
                  </TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead className="w-28 text-right">Followers</TableHead>
                  <TableHead className="w-36">Result</TableHead>
                  <TableHead>Link</TableHead>
                  <TableHead>Bio</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r, idx) => {
                  const meta = BUCKET_META[r.bucket];
                  const Icon = meta.icon;
                  const links = [...r.bioLinks, ...r.storyLinks];
                  return (
                    <TableRow key={r.username}>
                      <TableCell className="pl-4">
                        <input
                          type="checkbox"
                          checked={selected.has(r.username)}
                          // onClick, not onChange: only the click event carries
                          // shiftKey, which is what turns this into a range.
                          onChange={() => {}}
                          onClick={(e) => toggle(r.username, idx, e.shiftKey)}
                          className="size-4"
                        />
                      </TableCell>
                      <TableCell>
                        <a
                          href={`https://www.instagram.com/${r.username}/`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono hover:underline"
                        >
                          @{r.username}
                        </a>
                        {r.isVerified && (
                          <BadgeCheck className="inline size-3.5 ml-1 text-sky-400" />
                        )}
                        {r.fullName && (
                          <span className="block text-xs text-muted-foreground">{r.fullName}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {r.followers ? r.followers.toLocaleString("en-US") : "—"}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${meta.badgeCls}`}
                        >
                          <Icon className="size-3" /> {meta.label}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-md">
                        {links.length ? (
                          links.map((l) => (
                            <a
                              key={l}
                              href={l}
                              target="_blank"
                              rel="noreferrer"
                              className="block truncate text-xs text-sky-400 hover:underline"
                            >
                              {l}
                            </a>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">{r.note || "—"}</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-sm">
                        <span className="block text-xs text-muted-foreground line-clamp-2">
                          {r.biography || "—"}
                        </span>
                        {r.bioSignals.length > 0 && (
                          <span className="mt-0.5 inline-flex flex-wrap gap-1">
                            {r.bioSignals.map((sig) => (
                              <span
                                key={sig}
                                className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-400"
                              >
                                {sig}
                              </span>
                            ))}
                          </span>
                        )}
                        {r.highlightTitles.length > 0 && (
                          <span className="block text-[11px] text-violet-400/70 mt-0.5">
                            highlights: {r.highlightTitles.slice(0, 4).join(" · ")}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
