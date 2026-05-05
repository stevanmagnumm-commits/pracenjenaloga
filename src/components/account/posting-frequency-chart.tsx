"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface MediaItem {
  publishedAt: string | null;
}

interface PostingFrequencyChartProps {
  media: MediaItem[];
}

const BAR_COLORS = [
  "hsl(217.2 91.2% 59.8%)",
  "hsl(160 60% 45%)",
  "hsl(280 65% 60%)",
  "hsl(30 80% 55%)",
  "hsl(340 75% 55%)",
];

function getWeekLabel(date: Date): string {
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const diff = date.getTime() - startOfYear.getTime();
  const weekNum = Math.ceil(
    (diff / (7 * 24 * 60 * 60 * 1000) + startOfYear.getDay() + 1) / 7
  );
  return `W${weekNum}`;
}

function getWeekKey(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return d.toISOString().split("T")[0];
}

export function PostingFrequencyChart({ media }: PostingFrequencyChartProps) {
  const chartData = useMemo(() => {
    const weekMap = new Map<string, { key: string; label: string; count: number }>();

    for (const item of media) {
      if (!item.publishedAt) continue;
      const date = new Date(item.publishedAt);
      const key = getWeekKey(date);
      const existing = weekMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        weekMap.set(key, {
          key,
          label: getWeekLabel(date),
          count: 1,
        });
      }
    }

    return Array.from(weekMap.values())
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(-12);
  }, [media]);

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">
            Posting Frequency
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">
            No posting data available
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">
          Posting Frequency
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={chartData}>
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
              allowDecimals={false}
              width={30}
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
              formatter={(value: any) => [value, "Posts"]}
            />
            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
              {chartData.map((_, idx) => (
                <Cell
                  key={idx}
                  fill={BAR_COLORS[idx % BAR_COLORS.length]}
                  fillOpacity={0.85}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
