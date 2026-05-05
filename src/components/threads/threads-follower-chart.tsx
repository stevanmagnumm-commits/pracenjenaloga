"use client";

import { useState, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { formatNumber } from "@/lib/utils";

interface DataPoint {
  date: string;
  followers: number;
}

interface ThreadsFollowerChartProps {
  accountId: string;
}

const RANGE_OPTIONS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: 9999 },
] as const;

export function ThreadsFollowerChart({ accountId }: ThreadsFollowerChartProps) {
  const [range, setRange] = useState(30);
  const [data, setData] = useState<DataPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async (days: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/threads/growth/${accountId}?days=${days}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.dataPoints ?? []);
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    fetchData(range);
  }, [range, fetchData]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base font-medium">
          Follower Growth
        </CardTitle>
        <div className="flex gap-1">
          {RANGE_OPTIONS.map((opt) => (
            <Button
              key={opt.days}
              variant={range === opt.days ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setRange(opt.days)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex h-[300px] items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : data.length === 0 ? (
          <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
            No data available for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(217.2 32.6% 17.5%)"
              />
              <XAxis
                dataKey="date"
                tick={{ fill: "hsl(215 20.2% 65.1%)", fontSize: 12 }}
                tickLine={false}
                axisLine={{ stroke: "hsl(217.2 32.6% 17.5%)" }}
                tickFormatter={(v: string) => {
                  const d = new Date(v);
                  return `${d.getMonth() + 1}/${d.getDate()}`;
                }}
                minTickGap={40}
              />
              <YAxis
                tick={{ fill: "hsl(215 20.2% 65.1%)", fontSize: 12 }}
                tickLine={false}
                axisLine={{ stroke: "hsl(217.2 32.6% 17.5%)" }}
                tickFormatter={(v: number) => formatNumber(v)}
                width={60}
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
                  Number(value).toLocaleString(),
                  "Followers",
                ]}
                labelFormatter={(label: unknown) =>
                  new Date(String(label)).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                }
              />
              <Line
                type="monotone"
                dataKey="followers"
                stroke="hsl(217.2 91.2% 59.8%)"
                strokeWidth={2}
                dot={false}
                activeDot={{
                  r: 4,
                  fill: "hsl(217.2 91.2% 59.8%)",
                  stroke: "hsl(222.2 84% 4.9%)",
                  strokeWidth: 2,
                }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
