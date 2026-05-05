"use client";

import { useState, useEffect } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, TrendingUp, Eye, Calendar, ExternalLink } from "lucide-react";
import { formatNumber, formatEngagementRate } from "@/lib/utils";

interface PostingTimeHeatmap {
  day: number;
  hour: number;
  count: number;
  avgEngagement: number;
}

interface DurationBucket {
  label: string;
  minSeconds: number;
  maxSeconds: number;
  count: number;
  avgViews: number;
  avgEngagement: number;
}

interface AccountInsights {
  bestPostingTimes: PostingTimeHeatmap[];
  bestVideoLengths: DurationBucket[];
  avgEngagementRate: number;
  totalViews: number;
  totalMedia: number;
  postingFrequency: number;
}

interface TopMedia {
  id: string;
  shortcode: string | null;
  thumbnailUrl: string | null;
  snapshots: Array<{ viewCount: number }>;
}

interface InsightsPanelProps {
  accountId: string;
  media: TopMedia[];
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getHeatmapColor(value: number, max: number): string {
  if (max === 0) return "hsl(217.2 32.6% 12%)";
  const intensity = value / max;
  if (intensity > 0.75) return "hsl(160 60% 45%)";
  if (intensity > 0.5) return "hsl(160 50% 35%)";
  if (intensity > 0.25) return "hsl(160 40% 25%)";
  if (intensity > 0) return "hsl(160 30% 18%)";
  return "hsl(217.2 32.6% 12%)";
}

export function InsightsPanel({ accountId, media }: InsightsPanelProps) {
  const [insights, setInsights] = useState<AccountInsights | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/insights/${accountId}`);
        if (res.ok) {
          const json = await res.json();
          setInsights(json.insights);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [accountId]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!insights) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Failed to load insights
      </div>
    );
  }

  const top5Media = [...media]
    .sort(
      (a, b) =>
        (b.snapshots[0]?.viewCount ?? 0) - (a.snapshots[0]?.viewCount ?? 0)
    )
    .slice(0, 5);

  const maxEngagement = Math.max(
    ...insights.bestPostingTimes.map((t) => t.avgEngagement),
    0
  );

  const heatmapGrid: Record<string, number> = {};
  for (const entry of insights.bestPostingTimes) {
    heatmapGrid[`${entry.day}-${entry.hour}`] = entry.avgEngagement;
  }

  const visibleHours = [0, 3, 6, 9, 12, 15, 18, 21];

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 pt-0">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
              <TrendingUp className="size-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {formatEngagementRate(insights.avgEngagementRate)}
              </p>
              <p className="text-xs text-muted-foreground">
                Avg Engagement Rate
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 pt-0">
            <div className="flex size-10 items-center justify-center rounded-lg bg-chart-2/10">
              <Eye className="size-5 text-chart-2" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {formatNumber(insights.totalViews)}
              </p>
              <p className="text-xs text-muted-foreground">Total Views</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 pt-0">
            <div className="flex size-10 items-center justify-center rounded-lg bg-chart-4/10">
              <Calendar className="size-5 text-chart-4" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {insights.postingFrequency.toFixed(1)}
              </p>
              <p className="text-xs text-muted-foreground">Posts / Week</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Best Posting Times Heatmap */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">
            Best Posting Times
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <div className="min-w-[600px]">
              {/* Hour labels */}
              <div className="mb-1 flex">
                <div className="w-10 shrink-0" />
                {visibleHours.map((h) => (
                  <div
                    key={h}
                    className="flex-1 text-center text-xs text-muted-foreground"
                    style={{ minWidth: `${100 / 8}%` }}
                  >
                    {h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`}
                  </div>
                ))}
              </div>
              {/* Grid rows */}
              {DAY_LABELS.map((dayLabel, dayIdx) => (
                <div key={dayIdx} className="mb-0.5 flex items-center">
                  <div className="w-10 shrink-0 text-xs text-muted-foreground">
                    {dayLabel}
                  </div>
                  <div className="flex flex-1 gap-0.5">
                    {visibleHours.map((h) => {
                      const val = heatmapGrid[`${dayIdx}-${h}`] ?? 0;
                      return (
                        <div
                          key={h}
                          className="flex-1 rounded-sm transition-colors"
                          style={{
                            backgroundColor: getHeatmapColor(val, maxEngagement),
                            height: "28px",
                            minWidth: "28px",
                          }}
                          title={`${dayLabel} ${h}:00 — ER: ${formatEngagementRate(val)}`}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
              {/* Legend */}
              <div className="mt-3 flex items-center justify-end gap-1 text-xs text-muted-foreground">
                <span>Low</span>
                {[
                  "hsl(217.2 32.6% 12%)",
                  "hsl(160 30% 18%)",
                  "hsl(160 40% 25%)",
                  "hsl(160 50% 35%)",
                  "hsl(160 60% 45%)",
                ].map((color, i) => (
                  <div
                    key={i}
                    className="size-4 rounded-sm"
                    style={{ backgroundColor: color }}
                  />
                ))}
                <span>High</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Best Video Lengths */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">
            Performance by Video Length
          </CardTitle>
        </CardHeader>
        <CardContent>
          {insights.bestVideoLengths.filter((b) => b.count > 0).length ===
          0 ? (
            <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
              No duration data available
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart
                data={insights.bestVideoLengths.filter((b) => b.count > 0)}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(217.2 32.6% 17.5%)"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "hsl(215 20.2% 65.1%)", fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: "hsl(217.2 32.6% 17.5%)" }}
                />
                <YAxis
                  tick={{ fill: "hsl(215 20.2% 65.1%)", fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: "hsl(217.2 32.6% 17.5%)" }}
                  tickFormatter={(v: number) => formatNumber(v)}
                  width={50}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(222.2 84% 4.9%)",
                    border: "1px solid hsl(217.2 32.6% 17.5%)",
                    borderRadius: "8px",
                    color: "hsl(210 40% 98%)",
                  }}
                  labelStyle={{ color: "hsl(215 20.2% 65.1%)" }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: any) => [
                    formatNumber(Number(value)),
                    "Avg Views",
                  ]}
                />
                <Bar
                  dataKey="avgViews"
                  fill="hsl(280 65% 60%)"
                  radius={[4, 4, 0, 0]}
                  fillOpacity={0.85}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Top 5 Performing Reels */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">
            Top 5 Performing Reels
          </CardTitle>
        </CardHeader>
        <CardContent>
          {top5Media.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No media data available
            </div>
          ) : (
            <div className="space-y-3">
              {top5Media.map((item, idx) => {
                const views = item.snapshots[0]?.viewCount ?? 0;
                const igUrl = item.shortcode
                  ? `https://www.instagram.com/reel/${item.shortcode}/`
                  : null;

                return (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 rounded-lg bg-muted/30 p-2"
                  >
                    <span className="w-5 shrink-0 text-center text-sm font-bold text-muted-foreground">
                      {idx + 1}
                    </span>
                    {item.thumbnailUrl ? (
                      <img
                        src={item.thumbnailUrl}
                        alt=""
                        className="size-10 rounded object-cover"
                      />
                    ) : (
                      <div className="size-10 rounded bg-muted" />
                    )}
                    <div className="min-w-0 flex-1">
                      {item.shortcode && (
                        <a
                          href={igUrl!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm font-mono text-primary hover:underline"
                        >
                          {item.shortcode}
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-sm font-medium">
                      <Eye className="size-3.5 text-muted-foreground" />
                      {formatNumber(views)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
