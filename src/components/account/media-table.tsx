"use client";

import { useState, useMemo } from "react";
import { ExternalLink, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
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

interface MediaSnapshot {
  viewCount: number;
  likeCount: number;
  commentCount: number;
  engagementRate: number;
}

interface MediaItem {
  id: string;
  shortcode: string | null;
  mediaType: string;
  caption: string | null;
  thumbnailUrl: string | null;
  duration: number | null;
  publishedAt: string | null;
  snapshots: MediaSnapshot[];
}

interface MediaTableProps {
  media: MediaItem[];
}

type SortField =
  | "publishedAt"
  | "views"
  | "likes"
  | "comments"
  | "engagementRate"
  | "duration";

type SortDir = "asc" | "desc";

const PAGE_SIZE = 25;

const MEDIA_TYPE_STYLES: Record<string, string> = {
  REEL: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  IMAGE: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  CAROUSEL: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  VIDEO: "bg-green-500/15 text-green-400 border-green-500/30",
};

export function MediaTable({ media }: MediaTableProps) {
  const [sortField, setSortField] = useState<SortField>("publishedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
    setPage(0);
  }

  const sorted = useMemo(() => {
    const items = [...media];
    items.sort((a, b) => {
      const snapA = a.snapshots[0];
      const snapB = b.snapshots[0];
      let valA: number;
      let valB: number;

      switch (sortField) {
        case "publishedAt":
          valA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
          valB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
          break;
        case "views":
          valA = snapA?.viewCount ?? 0;
          valB = snapB?.viewCount ?? 0;
          break;
        case "likes":
          valA = snapA?.likeCount ?? 0;
          valB = snapB?.likeCount ?? 0;
          break;
        case "comments":
          valA = snapA?.commentCount ?? 0;
          valB = snapB?.commentCount ?? 0;
          break;
        case "engagementRate":
          valA = snapA?.engagementRate ?? 0;
          valB = snapB?.engagementRate ?? 0;
          break;
        case "duration":
          valA = a.duration ?? 0;
          valB = b.duration ?? 0;
          break;
        default:
          return 0;
      }
      return sortDir === "asc" ? valA - valB : valB - valA;
    });
    return items;
  }, [media, sortField, sortDir]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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
            className={`size-3 ${sortField === field ? "text-primary" : "text-muted-foreground/50"}`}
          />
        </button>
      </TableHead>
    );
  }

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">Thumb</TableHead>
            <TableHead>Shortcode</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="max-w-[200px]">Caption</TableHead>
            <SortableHeader field="duration">Duration</SortableHeader>
            <SortableHeader field="publishedAt">Published</SortableHeader>
            <SortableHeader field="views" className="text-right">
              Views
            </SortableHeader>
            <SortableHeader field="likes" className="text-right">
              Likes
            </SortableHeader>
            <SortableHeader field="comments" className="text-right">
              Comments
            </SortableHeader>
            <SortableHeader field="engagementRate" className="text-right">
              ER%
            </SortableHeader>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {paged.length === 0 ? (
            <TableRow>
              <TableCell colSpan={11} className="h-24 text-center text-muted-foreground">
                No media found
              </TableCell>
            </TableRow>
          ) : (
            paged.map((item) => {
              const snap = item.snapshots[0];
              const igUrl = item.shortcode
                ? `https://www.instagram.com/reel/${item.shortcode}/`
                : null;

              return (
                <TableRow key={item.id}>
                  <TableCell>
                    {item.thumbnailUrl ? (
                      <img
                        src={item.thumbnailUrl}
                        alt=""
                        className="size-10 rounded object-cover"
                      />
                    ) : (
                      <div className="size-10 rounded bg-muted" />
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.shortcode ? (
                      <a
                        href={igUrl!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {item.shortcode}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        MEDIA_TYPE_STYLES[item.mediaType] ??
                        "bg-muted text-muted-foreground"
                      }
                    >
                      {item.mediaType}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground">
                    {item.caption
                      ? item.caption.length > 80
                        ? item.caption.slice(0, 80) + "…"
                        : item.caption
                      : "—"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {item.duration ? formatDuration(item.duration) : "—"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {item.publishedAt
                      ? new Date(item.publishedAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {snap ? formatNumber(snap.viewCount) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {snap ? formatNumber(snap.likeCount) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {snap ? formatNumber(snap.commentCount) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {snap ? formatEngagementRate(snap.engagementRate) : "—"}
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

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-2">
          <p className="text-sm text-muted-foreground">
            Showing {page * PAGE_SIZE + 1}–
            {Math.min((page + 1) * PAGE_SIZE, sorted.length)} of{" "}
            {sorted.length}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-sm text-muted-foreground">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
