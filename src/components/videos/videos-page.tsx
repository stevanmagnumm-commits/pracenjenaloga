"use client";

import { useEffect, useState, useCallback } from "react";
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatNumber, formatEngagementRate, formatDuration } from "@/lib/utils";

interface VideoItem {
  id: string;
  shortcode: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  mediaType: string;
  duration: number | null;
  publishedAt: string | null;
  username: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  engagementRate: number;
}

interface VideosResponse {
  videos: VideoItem[];
  total: number;
  page: number;
  totalPages: number;
}

type SortField = "views" | "likes" | "comments" | "er" | "date" | "duration";
type SortDir = "asc" | "desc";
type TimeRange = "today" | "7d" | "30d" | "all";

const rangeLabels: Record<TimeRange, string> = {
  today: "Today",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  all: "All Time",
};

const MEDIA_TYPE_STYLES: Record<string, string> = {
  REEL: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  IMAGE: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  CAROUSEL: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  VIDEO: "bg-green-500/15 text-green-400 border-green-500/30",
};

export function VideosPage() {
  const [data, setData] = useState<VideosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<TimeRange>("all");
  const [sort, setSort] = useState<SortField>("views");
  const [dir, setDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);

  const fetchVideos = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        range,
        sort,
        dir,
        page: String(page),
        limit: "50",
      });
      const res = await fetch(`/api/videos?${params}`);
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, [range, sort, dir, page]);

  useEffect(() => {
    fetchVideos();
  }, [fetchVideos]);

  function handleSort(field: SortField) {
    if (sort === field) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setDir("desc");
    }
    setPage(1);
  }

  function SortableHeader({
    field,
    children,
    className,
  }: {
    field: SortField;
    children: React.ReactNode;
    className?: string;
  }) {
    return (
      <TableHead className={className}>
        <button
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          onClick={() => handleSort(field)}
        >
          {children}
          <ArrowUpDown
            className={`size-3 ${sort === field ? "text-primary" : "text-muted-foreground/50"}`}
          />
        </button>
      </TableHead>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">All Videos</h1>
          <p className="text-sm text-muted-foreground">
            {data ? `${data.total} videos tracked` : "Loading…"}
          </p>
        </div>
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {(Object.keys(rangeLabels) as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => {
                setRange(r);
                setPage(1);
              }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                range === r
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {rangeLabels[r]}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-20">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="max-w-[200px]">Caption</TableHead>
                  <SortableHeader field="duration">Duration</SortableHeader>
                  <SortableHeader field="date">Published</SortableHeader>
                  <SortableHeader field="views" className="text-right">
                    Views
                  </SortableHeader>
                  <SortableHeader field="likes" className="text-right">
                    Likes
                  </SortableHeader>
                  <SortableHeader field="comments" className="text-right">
                    Comments
                  </SortableHeader>
                  <SortableHeader field="er" className="text-right">
                    ER%
                  </SortableHeader>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {!data || data.videos.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={10}
                      className="h-24 text-center text-muted-foreground"
                    >
                      No videos found
                    </TableCell>
                  </TableRow>
                ) : (
                  data.videos.map((video) => {
                    const igUrl = video.shortcode
                      ? `https://www.instagram.com/reel/${video.shortcode}/`
                      : null;

                    return (
                      <TableRow key={video.id}>
                        <TableCell className="font-medium">
                          @{video.username}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={
                              MEDIA_TYPE_STYLES[video.mediaType] ??
                              "bg-muted text-muted-foreground"
                            }
                          >
                            {video.mediaType}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground">
                          {video.caption
                            ? video.caption.length > 60
                              ? video.caption.slice(0, 60) + "…"
                              : video.caption
                            : "—"}
                        </TableCell>
                        <TableCell className="text-sm">
                          {video.duration
                            ? formatDuration(video.duration)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-sm">
                          {video.publishedAt
                            ? new Date(video.publishedAt).toLocaleDateString(
                                "en-US",
                                {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                }
                              )
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatNumber(video.viewCount)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatNumber(video.likeCount)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatNumber(video.commentCount)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatEngagementRate(video.engagementRate)}
                        </TableCell>
                        <TableCell>
                          {igUrl && (
                            <a
                              href={igUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-primary transition-colors"
                            >
                              <ExternalLink className="size-4" />
                            </a>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between px-2">
              <p className="text-sm text-muted-foreground">
                Page {data.page} of {data.totalPages} ({data.total} total)
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="text-sm text-muted-foreground">
                  {page} / {data.totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= data.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
