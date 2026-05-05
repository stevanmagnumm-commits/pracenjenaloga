"use client";

import { LucideIcon } from "lucide-react";
import { formatNumber } from "@/lib/utils";

interface MetricCardProps {
  title: string;
  value: number;
  secondaryValue?: number;
  icon: LucideIcon;
  iconColor?: string;
}

export function MetricCard({
  title,
  value,
  secondaryValue,
  icon: Icon,
  iconColor = "text-primary",
}: MetricCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <Icon className={`size-5 ${iconColor}`} />
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <p className="text-3xl font-bold">{formatNumber(value)}</p>
        {secondaryValue !== undefined && (
          <p className="text-lg text-muted-foreground">
            / {formatNumber(secondaryValue)}
          </p>
        )}
      </div>
    </div>
  );
}
