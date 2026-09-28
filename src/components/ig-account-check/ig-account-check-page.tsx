"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Loader2,
  Play,
  Square,
  Trash2,
  Download,
  Copy,
  Check,
  ExternalLink,
  Images,
  FileStack,
  CalendarClock,
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

interface CheckResult {
  username: string;
  highlightCount: number | null;
  highlightTitles: string[];
  postCount: number | null;
  lastPostAt: string | null;
  status: "ok" | "gone" | "private" | "failed";
  note?: string;
}

interface CheckProgress {
  total: number;
  completed: number;
  current: string | null;
  running: boolean;
  wants: { highlights: boolean; posts: boolean; lastPost: boolean };
  startedAt: number | null;
  finishedAt: number | null;
  abortedReason: string | null;
  resultCount: number;
  rate: { used: number; limit: number };
  results: CheckResult[];
}

type FilterMode = "all" | "withHl" | "noHl" | "problem";

/** h:mm:ss while it is being watched, mm:ss under an hour. */
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export function IgAccountCheckPage() {
  const [input, setInput] = useState("");
  const [wantHl, setWantHl] = useState(true);
  const [wantPosts, setWantPosts] = useState(false);
  const [wantLast, setWantLast] = useState(false);
  const [progress, setProgress] = useState<CheckProgress | null>(null);
  const [rows, setRows] = useState<CheckResult[]>([]);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(300);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchResults = useCallback(async () => {
    try {
      const res = await fetch("/api/ig-account-check?results=1", { cache: "no-store" });
      const data: CheckProgress = await res.json();
      setProgress(data);
      setRows(data.results);
    } catch {}
  }, []);

  const pollProgress = useCallback(async () => {
    try {
      const res = await fetch("/api/ig-account-check", { cache: "no-store" });
      const data: CheckProgress = await res.json();
      setProgress(data);
      if (!data.running) {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        if (data.resultCount > 0) void fetchResults();
      }
    } catch {}
  }, [fetchResults]);

  useEffect(() => {
    void fetchResults();
    void pollProgress();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchResults, pollProgress]);

  useEffect(() => {
    if (progress?.running && !pollRef.current) {
      pollRef.current = setInterval(pollProgress, 1500);
    }
  }, [progress?.running, pollProgress]);

  useEffect(() => {
    if (!progress?.running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [progress?.running]);

  const usernames = () =>
    input
      .split(/[\n,\s]+/)
      .map((u) => u.trim().replace(/^@/, ""))
      .filter(Boolean);

  async function handleStart() {
    const list = usernames();
    if (!list.length) return;
    if (!wantHl && !wantPosts && !wantLast) return;
    setFilter("all");
    setShown(300);
    clear();
    const res = await fetch("/api/ig-account-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usernames: list,
        wants: { highlights: wantHl, posts: wantPosts, lastPost: wantLast },
      }),
    });
    if (res.ok) {
      setRows([]);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(pollProgress, 1500);
      void pollProgress();
    }
  }

  async function handleStop() {
    await fetch("/api/ig-account-check", { method: "DELETE" });
    void pollProgress();
  }

  function handleClear() {
    setInput("");
    setProgress(null);
    setRows([]);
    clear();
  }

  const filtered = rows.filter((r) => {
    if (filter === "withHl") return (r.highlightCount ?? 0) > 0;
    if (filter === "noHl") return r.highlightCount === 0;
    if (filter === "problem") return r.status !== "ok";
    return true;
  });

  const { selected, toggle, clear, toggleAll, allSelected } = useRowSelection(
    filtered.map((r) => r.username),
  );
  const selectedUsernames = () =>
    filtered.filter((r) => selected.has(r.username)).map((r) => r.username);

  function download(list: CheckResult[], what: string) {
    if (!list.length) return;
    const nl = "\r\n";
    const text = list.map((r) => r.username).join(nl) + nl;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `accounts-${new Date().toISOString().slice(0, 10)}-${what}-${list.length}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const withHl = rows.filter((r) => (r.highlightCount ?? 0) > 0);
  const noHl = rows.filter((r) => r.highlightCount === 0);
  const problems = rows.filter((r) => r.status !== "ok");

  const pct = progress?.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;
  const startedAt = progress?.startedAt ?? null;
  const stopStamp = progress?.running ? now : (progress?.finishedAt ?? now);
  const elapsedMs = startedAt ? stopStamp - startedAt : 0;
  const etaMs =
    progress?.running && startedAt && progress.completed > 0 && progress.total > progress.completed
      ? ((now - startedAt) / progress.completed) * (progress.total - progress.completed)
      : null;

  const nothingTicked = !wantHl && !wantPosts && !wantLast;
  const perAccount = (wantHl ? 1 : 0) + (wantPosts ? 1 : 0) + (wantLast ? 1 : 0);
  const pending = usernames().length;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Account Check</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste usernames and tick what you want to know. Each tick is one API
          call per account, so ask for only what you need.
        </p>
      </div>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Usernames, one per line..."
        className="w-full h-36 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        disabled={progress?.running}
      />

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={wantHl}
            onChange={(e) => setWantHl(e.target.checked)}
            disabled={progress?.running}
            className="size-4 rounded border-border accent-primary cursor-pointer"
          />
          <Images className="size-4 text-muted-foreground" />
          Has highlights
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={wantPosts}
            onChange={(e) => setWantPosts(e.target.checked)}
            disabled={progress?.running}
            className="size-4 rounded border-border accent-primary cursor-pointer"
          />
          <FileStack className="size-4 text-muted-foreground" />
          Total posts
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={wantLast}
            onChange={(e) => setWantLast(e.target.checked)}
            disabled={progress?.running}
            className="size-4 rounded border-border accent-primary cursor-pointer"
          />
          <CalendarClock className="size-4 text-muted-foreground" />
          Last post date
        </label>
        {pending > 0 && perAccount > 0 && (
          <span className="text-xs text-muted-foreground">
            {pending.toLocaleString("en-US")} accounts &times; {perAccount} call
            {perAccount === 1 ? "" : "s"} ={" "}
            <span className="font-mono text-foreground">
              {(pending * perAccount).toLocaleString("en-US")}
            </span>{" "}
            API calls
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          onClick={handleStart}
          disabled={progress?.running || !input.trim() || nothingTicked}
        >
          {progress?.running ? (
            <Loader2 className="mr-1.5 size-4 animate-spin" />
          ) : (
            <Play className="mr-1.5 size-4" />
          )}
          {progress?.running
            ? `Checking ${progress.completed}/${progress.total}...`
            : "Check accounts"}
        </Button>
        {progress?.running && (
          <Button variant="destructive" onClick={handleStop}>
            <Square className="mr-1.5 size-4" />
            Stop
          </Button>
        )}
        {rows.length > 0 && !progress?.running && (
          <Button variant="ghost" onClick={handleClear}>
            <Trash2 className="mr-1.5 size-4" />
            Clear
          </Button>
        )}
        {nothingTicked && (
          <span className="text-xs text-amber-400">Tick at least one thing to check</span>
        )}
      </div>

      {progress?.abortedReason && (
        <div className="rounded-md border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm">
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
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Running <span className="font-mono text-foreground">{fmtClock(elapsedMs)}</span>
            </span>
            {etaMs !== null && (
              <span>
                ~<span className="font-mono text-foreground">{fmtLeft(etaMs)}</span> left
              </span>
            )}
            {progress.rate && (
              <span>
                API <span className="font-mono text-foreground">{progress.rate.used}</span>/
                {progress.rate.limit} per min
              </span>
            )}
          </div>
        </div>
      )}

      {!progress?.running && progress?.finishedAt && progress?.startedAt && (
        <p className="text-xs text-muted-foreground">
          Run took{" "}
          <span className="font-mono text-foreground">
            {fmtClock(progress.finishedAt - progress.startedAt)}
          </span>
        </p>
      )}

      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(
              [
                ["all", "Checked", rows.length],
                ["withHl", "Has highlights", withHl.length],
                ["noHl", "No highlights", noHl.length],
                ["problem", "Gone / private / failed", problems.length],
              ] as [FilterMode, string, number][]
            ).map(([key, label, n]) => (
              <button
                key={key}
                onClick={() => {
                  setFilter(filter === key ? "all" : key);
                  setShown(300);
                  clear();
                }}
                className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                  filter === key ? "border-primary" : "border-border hover:border-muted-foreground"
                }`}
              >
                <div className="text-xs text-muted-foreground">{label}</div>
                <p className="text-2xl font-bold">{n.toLocaleString("en-US")}</p>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => download(withHl, "with-highlights")} disabled={!withHl.length}>
              <Download className="size-4" />
              {withHl.length.toLocaleString("en-US")} with highlights
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => download(noHl, "no-highlights")}
              disabled={!noHl.length}
            >
              <Download className="size-4" />
              {noHl.length.toLocaleString("en-US")} without
            </Button>
            <Button variant="outline" size="sm" onClick={toggleAll}>
              {allSelected ? "Deselect all" : "Select all shown"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!selected.size}
              onClick={() => {
                navigator.clipboard.writeText(selectedUsernames().join("\n"));
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              Copy {selected.size || ""}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!selected.size}
              onClick={() => openInstagramTabs(selectedUsernames())}
            >
              <ExternalLink className="size-4" />
              Open {selected.size || ""} in tabs
            </Button>
            <span className="text-sm text-muted-foreground ml-auto">
              {filtered.length.toLocaleString("en-US")} of {rows.length.toLocaleString("en-US")}
            </span>
          </div>

          {filtered.length > shown && (
            <div className="flex items-center justify-center gap-3 py-2">
              <span className="text-sm text-muted-foreground">
                Showing {shown.toLocaleString("en-US")} of {filtered.length.toLocaleString("en-US")}
                {" "}— filters and downloads use all of them
              </span>
              <Button variant="outline" size="sm" onClick={() => setShown(shown + 500)}>
                Show 500 more
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShown(filtered.length)}>
                Show all
              </Button>
            </div>
          )}

          <div className="rounded-lg border border-border overflow-x-auto">
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
                  <TableHead>Username</TableHead>
                  {progress?.wants.highlights && <TableHead className="w-28">Highlights</TableHead>}
                  {progress?.wants.posts && <TableHead className="w-24">Posts</TableHead>}
                  {progress?.wants.lastPost && <TableHead className="w-40">Last post</TableHead>}
                  <TableHead>Highlight names</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.slice(0, shown).map((r, idx) => (
                  <TableRow key={r.username}>
                    <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
                      <label className="flex items-center justify-center cursor-pointer py-2 px-1">
                        <input
                          type="checkbox"
                          checked={selected.has(r.username)}
                          onChange={() => {}}
                          onClick={(e) => toggle(r.username, idx, e.shiftKey)}
                          className="size-4 rounded border-border accent-primary cursor-pointer"
                        />
                      </label>
                    </TableCell>
                    <TableCell>
                      <a
                        href={`https://www.instagram.com/${r.username}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-sm hover:underline"
                      >
                        @{r.username}
                      </a>
                      {r.status !== "ok" && (
                        <span className="ml-2 rounded-full bg-zinc-500/15 px-2 py-0.5 text-xs text-zinc-400">
                          {r.status}
                        </span>
                      )}
                    </TableCell>
                    {progress?.wants.highlights && (
                      <TableCell>
                        {r.highlightCount === null ? (
                          <span className="text-xs text-muted-foreground">not read</span>
                        ) : r.highlightCount === 0 ? (
                          <span className="text-xs text-zinc-500">none</span>
                        ) : (
                          <span className="font-mono text-emerald-400">{r.highlightCount}</span>
                        )}
                      </TableCell>
                    )}
                    {progress?.wants.posts && (
                      <TableCell className="font-mono text-sm">
                        {r.postCount === null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          r.postCount.toLocaleString("en-US")
                        )}
                      </TableCell>
                    )}
                    {progress?.wants.lastPost && (
                      <TableCell className="text-sm">
                        {r.lastPostAt ? (
                          <>
                            {new Date(r.lastPostAt).toLocaleDateString("en-GB")}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {daysAgo(r.lastPostAt)}d ago
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell className="text-xs text-muted-foreground">
                      {r.highlightTitles.join(" · ")}
                      {r.note && <div className="text-amber-400/70">{r.note}</div>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
