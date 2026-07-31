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
  source?: "ytdlp" | "api";
  fileName?: string;
  downloadUrl?: string;
  error?: string;
}

const MAX_URLS = 20;

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

  // One request per link, so results appear as they finish and no single request
  // can outlive the gateway timeout — on the RapidAPI fallback a link may need a
  // dozen retries and take ~20s on its own.
  const resolveOne = async (url: string): Promise<ResolvedItem> => {
    try {
      const res = await fetch("/api/tiktok/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: [url], watermark }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { input: url, error: data.error || `Request failed (${res.status})` };
      }
      if (typeof data.quotaRemaining === "number") setQuota(data.quotaRemaining);
      return data.results?.[0] || { input: url, error: "No result returned" };
    } catch {
      return { input: url, error: "Network error — try this link again" };
    }
  };

  const handleResolve = async () => {
    if (urls.length === 0) return;

    setLoading(true);
    setItems([]);

    for (let i = 0; i < urls.length; i++) {
      setMessage(`Resolving ${i + 1} of ${urls.length}…`);
      const resolved = await resolveOne(urls[i]);
      setItems((prev) => [...prev, resolved]);
    }

    setMessage("");
    setLoading(false);
  };

  const handleRetryOne = async (index: number) => {
    const url = items[index].input;
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, error: "Retrying…" } : it)));
    const next = await resolveOne(url);
    setItems((prev) => prev.map((it, i) => (i === index ? next : it)));
  };

  // Browsers throttle simultaneous downloads, so kick them off one at a time.
  const handleDownloadAll = () => {
    const ready = items.filter((i) => i.downloadUrl);
    ready.forEach((item, idx) => {
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = item.downloadUrl!;
        a.download = item.fileName || "tiktok.mp4";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, idx * 1200);
    });
  };

  const readyCount = items.filter((i) => i.downloadUrl).length;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">TikTok Downloader</h1>
        <p className="text-sm text-muted-foreground">
          Paste TikTok video links to download the MP4 files — highest quality, no watermark
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
            <span className="text-xs text-muted-foreground">(uses API quota)</span>
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
              Provider quota left today: <strong>{quota}</strong>{" "}
              <span className="opacity-70">(≈{Math.floor(quota / 5)} videos)</span>
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
                      {item.source === "api" && (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                          via API
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                      {item.title || "(no caption)"}
                    </p>
                  </>
                )}
              </div>

              {item.downloadUrl ? (
                <a
                  href={item.downloadUrl}
                  download={item.fileName}
                  className="flex-shrink-0 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Download
                </a>
              ) : (
                item.error &&
                item.error !== "Retrying…" && (
                  <button
                    onClick={() => handleRetryOne(idx)}
                    className="flex-shrink-0 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                  >
                    Retry
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
