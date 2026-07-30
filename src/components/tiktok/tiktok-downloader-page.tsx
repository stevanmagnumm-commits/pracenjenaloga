"use client";

import { useState } from "react";
import { formatDuration } from "@/lib/utils";

interface ResolvedItem {
  input: string;
  videoId?: string;
  author?: string;
  title?: string;
  coverUrl?: string;
  duration?: number;
  play?: string;
  playWatermark?: string;
  fileName?: string;
  error?: string;
}

const MAX_URLS = 20;

function fileHref(item: ResolvedItem, watermark: boolean): string {
  const src = watermark && item.playWatermark ? item.playWatermark : item.play;
  if (!src) return "#";
  const name = item.fileName || "tiktok.mp4";
  return `/api/tiktok/download/file?src=${encodeURIComponent(src)}&name=${encodeURIComponent(name)}`;
}

export function TikTokDownloaderPage() {
  const [input, setInput] = useState("");
  const [items, setItems] = useState<ResolvedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [watermark, setWatermark] = useState(false);
  const [quota, setQuota] = useState<number | null>(null);

  const urls = input
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const handleResolve = async () => {
    if (urls.length === 0) return;

    setLoading(true);
    setItems([]);
    setMessage(`Resolving ${urls.length} link(s)… this can take a few seconds each.`);

    try {
      const res = await fetch("/api/tiktok/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || "Request failed");
        return;
      }
      setItems(data.results || []);
      setQuota(typeof data.quotaRemaining === "number" ? data.quotaRemaining : null);
      setMessage("");
    } catch {
      setMessage("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Browsers throttle simultaneous downloads, so kick them off one at a time.
  const handleDownloadAll = () => {
    const ready = items.filter((i) => i.play);
    ready.forEach((item, idx) => {
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = fileHref(item, watermark);
        a.download = item.fileName || "tiktok.mp4";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, idx * 1200);
    });
  };

  const readyCount = items.filter((i) => i.play).length;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">TikTok Downloader</h1>
        <p className="text-sm text-muted-foreground">
          Paste TikTok video links to download the MP4 files — without watermark by default
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div>
          <label className="text-sm font-medium text-foreground">
            TikTok Links{" "}
            <span className="font-normal text-muted-foreground">
              (one per line, max {MAX_URLS})
            </span>
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              "https://www.tiktok.com/@username/video/1234567890123456789\nhttps://www.tiktok.com/@another/video/9876543210987654321"
            }
            rows={5}
            className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <button
            onClick={handleResolve}
            disabled={loading || urls.length === 0}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Resolving…" : `Get Downloads${urls.length ? ` (${urls.length})` : ""}`}
          </button>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={watermark}
              onChange={(e) => setWatermark(e.target.checked)}
              className="size-4 rounded border-border"
            />
            Include watermark
          </label>

          {readyCount > 1 && (
            <button
              onClick={handleDownloadAll}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Download all ({readyCount})
            </button>
          )}

          {quota !== null && (
            <span className="text-xs text-muted-foreground">
              Provider quota left today: <strong>{quota}</strong>
            </span>
          )}
        </div>

        {message && (
          <p className="text-sm text-muted-foreground animate-pulse">{message}</p>
        )}
      </div>

      {items.length > 0 && (
        <div className="space-y-3">
          {items.map((item, idx) => (
            <div
              key={`${item.input}-${idx}`}
              className="flex items-center gap-4 rounded-lg border border-border bg-card p-3"
            >
              {item.coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.coverUrl}
                  alt=""
                  className="h-24 w-16 flex-shrink-0 rounded-md object-cover"
                />
              ) : (
                <div className="h-24 w-16 flex-shrink-0 rounded-md bg-muted" />
              )}

              <div className="min-w-0 flex-1">
                {item.error ? (
                  <>
                    <p className="truncate text-sm font-medium text-foreground">{item.input}</p>
                    <p className="mt-1 text-sm text-destructive">{item.error}</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-foreground">
                      @{item.author || "unknown"}
                      {item.duration ? (
                        <span className="ml-2 font-normal text-muted-foreground">
                          {formatDuration(item.duration)}
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                      {item.title || "(no caption)"}
                    </p>
                  </>
                )}
              </div>

              {item.play && (
                <a
                  href={fileHref(item, watermark)}
                  download={item.fileName}
                  className="flex-shrink-0 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Download
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
