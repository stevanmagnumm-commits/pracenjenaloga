"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { formatNumber } from "@/lib/utils";

interface ViewsChartProps {
  data: { date: string; views: number }[];
}

export function ViewsChart({ data }: ViewsChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-[300px] items-center justify-center text-muted-foreground">
        No data available for this time range
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
        <defs>
          <linearGradient id="viewsGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
          tickFormatter={(val: string) => {
            const d = new Date(val + "T00:00:00");
            return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          }}
        />
        <YAxis
          tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
          tickFormatter={(val: number) => formatNumber(val)}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
            fontSize: "13px",
          }}
          formatter={(value: any) => [formatNumber(Number(value)), "Views"]}
          labelFormatter={(label: any) => {
            const d = new Date(String(label) + "T00:00:00");
            return d.toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
            });
          }}
        />
        <Area
          type="monotone"
          dataKey="views"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          fill="url(#viewsGradient)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
