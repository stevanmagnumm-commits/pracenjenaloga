"use client";

import { useEffect, useState, useCallback } from "react";
import { Users, TrendingUp, UserCheck, BarChart3 } from "lucide-react";
import { MetricCard } from "@/components/overview/metric-card";

interface OverviewData {
  totalAccounts: number;
  totalFollowers: number;
  avgFollowers: number;
  totalGrowth30d: number;
}

export function ThreadsOverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/threads/overview");
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Threads Overview</h1>
        <p className="text-sm text-muted-foreground">
          Follower tracking across all Threads accounts
        </p>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-20">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            title="Accounts Tracked"
            value={data.totalAccounts}
            icon={UserCheck}
            iconColor="text-purple-400"
          />
          <MetricCard
            title="Total Followers"
            value={data.totalFollowers}
            icon={Users}
            iconColor="text-blue-400"
          />
          <MetricCard
            title="Avg Followers"
            value={data.avgFollowers}
            icon={BarChart3}
            iconColor="text-cyan-400"
          />
          <MetricCard
            title="30d Growth"
            value={data.totalGrowth30d}
            icon={TrendingUp}
            iconColor="text-green-400"
          />
        </div>
      ) : (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          Failed to load data
        </div>
      )}
    </div>
  );
}
