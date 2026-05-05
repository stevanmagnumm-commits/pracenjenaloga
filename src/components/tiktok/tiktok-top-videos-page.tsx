"use client";

import { useState } from "react";
import { formatNumber, formatDuration } from "@/lib/utils";

interface TikTokVideo {
  id: string;
  desc: string;
  createTime: number;
  duration: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  author: string;
  authorNickname: string;
  coverUrl: string;
}

interface AccountResult {
  username: string;
  nickname: string;
  followerCount: number;
  verified: boolean;
  videos: TikTokVideo[];
  error?: string;
}

export function TikTokTopVideosPage() {
  const [input, setInput] = useState("");
  const [results, setResults] = useState<AccountResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [topN, setTopN] = useState(12);

  const handleSearch = async () => {
    const usernames = input
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (usernames.length === 0) return;

    setLoading(true);
    setResults([]);
    setProgress(`Fetching data for ${usernames.length} account(s)...`);

    try {
      const res = await fetch("/api/tiktok/top-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames, topN, maxPages: 5 }),
      });
      const data = await res.json();
      setResults(data.results || []);
      setProgress("");
    } catch {
      setProgress("Error fetching data. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">TikTok Top Videos</h1>
        <p className="text-sm text-muted-foreground">
          Enter TikTok usernames to find their top performing videos by views
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div>
          <label className="text-sm font-medium text-foreground">
            TikTok Usernames
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={"Enter usernames (one per line or comma-separated)\ne.g.\ntaylorswift\ncharlidamelio\nkhaby.lame"}
            rows={5}
            className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-foreground">
              Top videos per account:
            </label>
            <select
              value={topN}
              onChange={(e) => setTopN(Number(e.target.value))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={12}>12</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
            </select>
          </div>

          <button
            onClick={handleSearch}
            disabled={loading || !input.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Loading..." : "Find Top Videos"}
          </button>
        </div>

        {progress && (
          <p className="text-sm text-muted-foreground animate-pulse">
            {progress}
          </p>
        )}
      </div>

      {results.map((account) => (
        <div
          key={account.username}
          className="rounded-lg border border-border bg-card overflow-hidden"
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground">
                  @{account.username}
                </span>
                {account.verified && (
                  <span className="rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    ✓
                  </span>
                )}
                {account.nickname && (
                  <span className="text-sm text-muted-foreground">
                    ({account.nickname})
                  </span>
                )}
              </div>
              {account.followerCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {formatNumber(account.followerCount)} followers
                </span>
              )}
            </div>
            {account.error && (
              <span className="text-xs text-red-400">{account.error}</span>
            )}
          </div>

          {account.videos.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 w-8">#</th>
                    <th className="px-4 py-2.5">Description</th>
                    <th className="px-4 py-2.5 text-right">Views</th>
                    <th className="px-4 py-2.5 text-right">Likes</th>
                    <th className="px-4 py-2.5 text-right">Comments</th>
                    <th className="px-4 py-2.5 text-right">Shares</th>
                    <th className="px-4 py-2.5 text-right">Saves</th>
                    <th className="px-4 py-2.5 text-right">Duration</th>
                    <th className="px-4 py-2.5 text-right">Posted</th>
                  </tr>
                </thead>
                <tbody>
                  {account.videos.map((video, idx) => (
                    <tr
                      key={video.id}
                      className="border-b border-border/50 transition-colors hover:bg-accent/50"
                    >
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {idx + 1}
                      </td>
                      <td className="max-w-xs truncate px-4 py-2.5">
                        <a
                          href={`https://www.tiktok.com/@${video.author}/video/${video.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground hover:text-primary hover:underline"
                          title={video.desc}
                        >
                          {video.desc || "No caption"}
                        </a>
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-foreground">
                        {formatNumber(video.views)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">
                        {formatNumber(video.likes)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">
                        {formatNumber(video.comments)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">
                        {formatNumber(video.shares)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">
                        {formatNumber(video.saves)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">
                        {formatDuration(video.duration)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">
                        {new Date(video.createTime * 1000).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !account.error && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No videos found
              </div>
            )
          )}
        </div>
      ))}
    </div>
  );
}
