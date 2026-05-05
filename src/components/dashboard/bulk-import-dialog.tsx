"use client";

import { useState, useEffect, useRef } from "react";
import { Upload, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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

interface BulkImportDialogProps {
  onSuccess: () => void;
}

export function BulkImportDialog({ onSuccess }: BulkImportDialogProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [refreshInterval, setRefreshInterval] = useState("EIGHT_HOURS");
  const [priority, setPriority] = useState("2");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  useEffect(() => {
    return stopPolling;
  }, []);

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/accounts/bulk");
        if (!res.ok) return;
        const data: BulkProgress = await res.json();
        setProgress(data);

        if (!data.running) {
          stopPolling();
          setLoading(false);
          onSuccess();
        }
      } catch {}
    }, 2000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const usernames = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (usernames.length === 0) return;

    setLoading(true);
    setError(null);
    setProgress(null);

    try {
      const res = await fetch("/api/accounts/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usernames,
          refreshInterval,
          priority: Number(priority),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to start bulk import");
      }

      const data = await res.json();

      if (data.total === 0) {
        setError(data.message || "All accounts are already tracked");
        setLoading(false);
        return;
      }

      setProgress({
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
      setOpen(value);
      if (!value) {
        setText("");
        setProgress(null);
        setError(null);
      }
    }
  }

  const isImporting = loading && progress?.running;
  const isDone = progress && !progress.running && progress.completed > 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload className="size-4" />
          Bulk Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bulk Import Accounts</DialogTitle>
          <DialogDescription>
            Paste Instagram usernames, one per line.
          </DialogDescription>
        </DialogHeader>

        {!isImporting && !isDone && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Usernames</label>
              <textarea
                className="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                placeholder={"username1\nusername2\nhttps://instagram.com/username3"}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Refresh Interval</label>
                <Select value={refreshInterval} onValueChange={setRefreshInterval}>
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

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button
                type="submit"
                disabled={loading || !text.trim()}
              >
                {loading && <Loader2 className="size-4 animate-spin" />}
                Start Import
              </Button>
            </DialogFooter>
          </form>
        )}

        {(isImporting || isDone) && progress && (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {progress.running
                    ? `Importing ${progress.completed + 1}/${progress.total}`
                    : `Done — ${progress.completed}/${progress.total}`}
                </span>
                {progress.current && (
                  <span className="font-mono text-foreground">
                    @{progress.current}
                  </span>
                )}
              </div>
              <Progress value={progress.completed} max={progress.total} />
            </div>

            {progress.successes.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Imported ({progress.successes.length})
                </p>
                <div className="max-h-32 space-y-0.5 overflow-y-auto">
                  {progress.successes.map((u) => (
                    <div key={u} className="flex items-center gap-1.5 text-sm text-green-500">
                      <CheckCircle2 className="size-3.5 shrink-0" />
                      @{u}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {progress.errors.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Errors ({progress.errors.length})
                </p>
                <div className="max-h-32 space-y-0.5 overflow-y-auto">
                  {progress.errors.map((e) => (
                    <div key={e.username} className="flex items-center gap-1.5 text-sm text-destructive">
                      <XCircle className="size-3.5 shrink-0" />
                      @{e.username}: {e.error}
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
