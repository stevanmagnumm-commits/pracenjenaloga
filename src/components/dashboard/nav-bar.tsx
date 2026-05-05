"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, Activity } from "lucide-react";
import { formatNumber } from "@/lib/utils";

export function NavBar() {
  const [usage, setUsage] = useState<{ callCount: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/usage");
      if (res.ok) setUsage(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchUsage();
    const interval = setInterval(fetchUsage, 30_000);
    return () => clearInterval(interval);
  }, [fetchUsage]);

  async function handleRefreshAll() {
    setRefreshing(true);
    try {
      await fetch("/api/refresh", { method: "POST" });
      await fetchUsage();
    } catch {} finally {
      setRefreshing(false);
    }
  }

  return (
    <nav className="fixed top-0 z-50 flex h-16 w-full items-center border-b border-border bg-background/80 px-6 backdrop-blur-md">
      <div className="flex flex-1 items-center gap-2">
        <Activity className="size-5 text-primary" />
        <span className="text-lg font-bold tracking-tight">Pracenje Naloga</span>
      </div>

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="hidden sm:inline">API:</span>
        <span className="font-mono font-medium text-foreground">
          {usage ? formatNumber(usage.callCount) : "—"} / 50,000
        </span>
        <span className="hidden sm:inline">calls</span>
      </div>

      <div className="flex flex-1 justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefreshAll}
          disabled={refreshing}
        >
          <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh All</span>
        </Button>
      </div>
    </nav>
  );
}
