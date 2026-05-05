"use client";

import { useEffect, useState, useCallback } from "react";
import { Eye, Users, Film } from "lucide-react";
import { MetricCard } from "./metric-card";
import { ViewsChart } from "./views-chart";
import { TopVideos } from "./top-videos";

interface OverviewData {
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  totalEngagement: number;
  totalAccounts: number;
  trackedMedia: number;
  totalMediaFromAPI: number;
  viewsChart: { date: string; views: number }[];
  topVideos: {
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
  }[];
}

type TimeRange = "today" | "7d" | "30d" | "all";

const rangeLabels: Record<TimeRange, string> = {
  today: "Today",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  all: "All Time",
};

export function OverviewPage() {
  const [range, setRange] = useState<TimeRange>("7d");
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/overview?range=${range}`, { cache: "no-store" });
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Aggregate metrics across all tracked accounts
          </p>
        </div>
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {(Object.keys(rangeLabels) as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
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
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard title="Total Views" value={data.totalViews} icon={Eye} iconColor="text-blue-400" />
            <MetricCard title="Avg Views / Video" value={data.trackedMedia > 0 ? Math.round(data.totalViews / data.trackedMedia) : 0} icon={Eye} iconColor="text-cyan-400" />
            <MetricCard title="Videos Tracked" value={data.trackedMedia} secondaryValue={data.totalMediaFromAPI} icon={Film} iconColor="text-green-400" />
            <MetricCard title="Accounts" value={data.totalAccounts} icon={Users} iconColor="text-purple-400" />
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 text-lg font-semibold">Views Over Time</h2>
            <ViewsChart data={data.viewsChart} />
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 text-lg font-semibold">Most Viral Videos</h2>
            <TopVideos videos={data.topVideos} />
          </div>
        </>
      ) : (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          Failed to load data
        </div>
      )}
    </div>
  );
}
