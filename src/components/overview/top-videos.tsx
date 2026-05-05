"use client";

import { ExternalLink } from "lucide-react";
import { formatNumber, formatEngagementRate } from "@/lib/utils";

interface TopVideo {
  id: string;
  shortcode: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  username: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  engagementRate: number;
}

interface TopVideosProps {
  videos: TopVideo[];
}

export function TopVideos({ videos }: TopVideosProps) {
  if (videos.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        No videos tracked yet
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {videos.map((video, idx) => {
        const igUrl = video.shortcode
          ? `https://www.instagram.com/reel/${video.shortcode}/`
          : null;

        return (
          <div
            key={video.id}
            className="flex items-center gap-4 rounded-lg border border-border bg-card/50 p-3"
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
              {idx + 1}
            </div>
            {video.thumbnailUrl ? (
              <img
                src={video.thumbnailUrl}
                alt=""
                className="size-12 shrink-0 rounded-lg object-cover"
              />
            ) : (
              <div className="size-12 shrink-0 rounded-lg bg-muted" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-muted-foreground">
                @{video.username}
              </p>
              <p className="truncate text-sm">
                {video.caption
                  ? video.caption.length > 60
                    ? video.caption.slice(0, 60) + "…"
                    : video.caption
                  : "No caption"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-6 text-right">
              <div>
                <p className="text-sm font-semibold">{formatNumber(video.viewCount)}</p>
                <p className="text-xs text-muted-foreground">views</p>
              </div>
              <div>
                <p className="text-sm font-semibold">{formatNumber(video.likeCount)}</p>
                <p className="text-xs text-muted-foreground">likes</p>
              </div>
              <div>
                <p className="text-sm font-semibold">
                  {formatEngagementRate(video.engagementRate)}
                </p>
                <p className="text-xs text-muted-foreground">ER</p>
              </div>
              {igUrl && (
                <a
                  href={igUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground transition-colors hover:text-primary"
                >
                  <ExternalLink className="size-4" />
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
