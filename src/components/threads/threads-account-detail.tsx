"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, RefreshCw, Loader2, BadgeCheck, Users, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/utils";
import { ThreadsFollowerChart } from "./threads-follower-chart";

interface ThreadsAccountData {
  id: string;
  threadsPk: string | null;
  username: string;
  fullName: string | null;
  bio: string | null;
  isVerified: boolean;
  followerCount: number;
  lastRefreshedAt: string | null;
  createdAt: string;
}

interface ThreadsAccountDetailProps {
  account: ThreadsAccountData;
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

export function ThreadsAccountDetail({ account }: ThreadsAccountDetailProps) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await fetch(`/api/threads/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: account.username }),
      });
      router.refresh();
    } catch {
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/threads/accounts"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
          Back to Accounts
        </Link>

        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 className="mr-1.5 size-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 size-4" />
          )}
          Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="pt-0">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold">@{account.username}</h1>
              {account.isVerified && (
                <BadgeCheck className="size-5 text-primary" />
              )}
              <Badge variant="outline" className="bg-purple-500/15 text-purple-400 border-purple-500/30">
                Threads
              </Badge>
            </div>
            {account.fullName && (
              <p className="text-muted-foreground">{account.fullName}</p>
            )}
            {account.bio && (
              <p className="max-w-xl text-sm text-muted-foreground">{account.bio}</p>
            )}

            <div className="flex flex-wrap gap-4">
              <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-4 py-2">
                <Users className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-lg font-bold">{formatNumber(account.followerCount)}</p>
                  <p className="text-xs text-muted-foreground">Followers</p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3" />
              Last refreshed: {timeAgo(account.lastRefreshedAt)}
            </div>
          </div>
        </CardContent>
      </Card>

      <ThreadsFollowerChart accountId={account.id} />
    </div>
  );
}
