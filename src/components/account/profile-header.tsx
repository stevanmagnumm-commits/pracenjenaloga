import {
  BadgeCheck,
  Image,
  Clock,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/utils";
import type { SerializedAccount } from "./account-detail-client";

const PRIORITY_CONFIG: Record<number, { label: string; className: string }> = {
  1: { label: "High", className: "bg-red-500/15 text-red-400 border-red-500/30" },
  2: { label: "Medium", className: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  3: { label: "Low", className: "bg-green-500/15 text-green-400 border-green-500/30" },
};

function getInitials(name: string | null, username: string): string {
  if (name) {
    return name
      .split(" ")
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  }
  return username.slice(0, 2).toUpperCase();
}

function timeAgo(dateString: string | null): string {
  if (!dateString) return "Never";
  const seconds = Math.floor(
    (Date.now() - new Date(dateString).getTime()) / 1000
  );
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface ProfileHeaderProps {
  account: SerializedAccount;
}

export function ProfileHeader({ account }: ProfileHeaderProps) {
  const snap = account.snapshots[0] ?? null;
  const priority = PRIORITY_CONFIG[account.priority] ?? PRIORITY_CONFIG[2];

  return (
    <Card>
      <CardContent className="pt-0">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-bold">@{account.username}</h1>
                {account.isVerified && (
                  <BadgeCheck className="size-5 text-primary" />
                )}
                <Badge variant="outline" className={priority.className}>
                  {priority.label} Priority
                </Badge>
              </div>
              {account.fullName && (
                <p className="mt-0.5 text-muted-foreground">
                  {account.fullName}
                </p>
              )}
              {account.bio && (
                <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                  {account.bio}
                </p>
              )}
            </div>

            {snap && (
              <div className="flex flex-wrap gap-4">
                <StatBlock
                  icon={<Image className="size-4" />}
                  value={formatNumber(snap.mediaCount)}
                  label="Posts"
                />
              </div>
            )}

            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3" />
              Last refreshed: {timeAgo(account.lastRefreshedAt)}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StatBlock({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-4 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <div>
        <p className="text-lg font-bold">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
