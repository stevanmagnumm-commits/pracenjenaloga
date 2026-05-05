"use client";

import { useState } from "react";
import Link from "next/link";
import { X, BadgeCheck, Users, UserPlus, Image, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/utils";

interface AccountSnapshot {
  followerCount: number;
  followingCount: number;
  mediaCount: number;
  snapshotAt: string;
}

export interface TrackedAccount {
  id: string;
  igUserId: string | null;
  username: string;
  fullName: string | null;
  bio: string | null;
  profilePicUrl: string | null;
  isVerified: boolean;
  refreshInterval: string;
  priority: number;
  lastRefreshedAt: string | null;
  createdAt: string;
  snapshots: AccountSnapshot[];
  _count: { media: number };
}

interface AccountCardProps {
  account: TrackedAccount;
  onDelete: (id: string) => void;
}

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
  const seconds = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function AccountCard({ account, onDelete }: AccountCardProps) {
  const [deleting, setDeleting] = useState(false);

  const snap = account.snapshots[0] ?? null;
  const priority = PRIORITY_CONFIG[account.priority] ?? PRIORITY_CONFIG[2];

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/accounts?id=${account.id}`, { method: "DELETE" });
      if (res.ok) onDelete(account.id);
    } catch {} finally {
      setDeleting(false);
    }
  }

  return (
    <Card className="group relative transition-colors hover:border-primary/30">
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 size-7 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={handleDelete}
        disabled={deleting}
      >
        {deleting ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <X className="size-3.5" />
        )}
      </Button>

      <CardContent className="space-y-3 pt-0">
        <div className="flex items-center gap-3">
          {account.profilePicUrl ? (
            <img
              src={account.profilePicUrl}
              alt={account.username}
              className="size-12 rounded-full object-cover ring-2 ring-border"
            />
          ) : (
            <div className="flex size-12 items-center justify-center rounded-full bg-muted text-sm font-semibold ring-2 ring-border">
              {getInitials(account.fullName, account.username)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <Link
                href={`/account/${account.id}`}
                className="truncate font-semibold hover:text-primary hover:underline"
              >
                @{account.username}
              </Link>
              {account.isVerified && (
                <BadgeCheck className="size-4 shrink-0 text-primary" />
              )}
            </div>
            {account.fullName && (
              <p className="truncate text-sm text-muted-foreground">
                {account.fullName}
              </p>
            )}
          </div>
        </div>

        {snap && (
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-2.5">
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-muted-foreground">
                <Users className="size-3" />
              </div>
              <p className="text-sm font-semibold">{formatNumber(snap.followerCount)}</p>
              <p className="text-xs text-muted-foreground">Followers</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-muted-foreground">
                <UserPlus className="size-3" />
              </div>
              <p className="text-sm font-semibold">{formatNumber(snap.followingCount)}</p>
              <p className="text-xs text-muted-foreground">Following</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-muted-foreground">
                <Image className="size-3" />
              </div>
              <p className="text-sm font-semibold">{formatNumber(snap.mediaCount)}</p>
              <p className="text-xs text-muted-foreground">Posts</p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={priority.className}>
              {priority.label}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">
            {timeAgo(account.lastRefreshedAt)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
