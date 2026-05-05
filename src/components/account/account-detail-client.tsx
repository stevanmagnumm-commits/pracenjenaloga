"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  RefreshCw,
  Download,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProfileHeader } from "./profile-header";
import { PostingFrequencyChart } from "./posting-frequency-chart";
import { MediaTable } from "./media-table";
import { InsightsPanel } from "./insights-panel";

interface AccountSnapshot {
  id: string;
  accountId: string;
  followerCount: number;
  followingCount: number;
  mediaCount: number;
  snapshotAt: string;
}

interface MediaSnapshot {
  id: string;
  mediaId: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  engagementRate: number;
  snapshotAt: string;
}

interface MediaItem {
  id: string;
  accountId: string;
  igMediaId: string;
  mediaType: string;
  shortcode: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  duration: number | null;
  publishedAt: string | null;
  createdAt: string;
  snapshots: MediaSnapshot[];
}

export interface SerializedAccount {
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
  updatedAt: string;
  snapshots: AccountSnapshot[];
  media: MediaItem[];
}

interface AccountDetailClientProps {
  account: SerializedAccount;
}

export function AccountDetailClient({ account }: AccountDetailClientProps) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const res = await fetch(
        `/api/refresh?accountId=${account.id}`,
        { method: "POST" }
      );
      if (res.ok) {
        window.location.reload();
      } else {
        const data = await res.json();
        alert(`Refresh failed: ${data.error || "Unknown error"}`);
      }
    } catch {
      alert("Refresh failed: network error");
    } finally {
      setRefreshing(false);
    }
  }

  function handleExport(type: "account" | "media") {
    setExportOpen(false);
    window.open(`/api/export/${account.id}?type=${type}`, "_blank");
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/accounts"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
          Back to Accounts
        </Link>

        <div className="flex items-center gap-2">
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

          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExportOpen((v) => !v)}
            >
              <Download className="mr-1.5 size-4" />
              Export CSV
              <ChevronDown className="ml-1 size-3" />
            </Button>
            {exportOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setExportOpen(false)}
                />
                <div className="absolute right-0 z-50 mt-1 w-44 rounded-md border bg-popover p-1 shadow-md">
                  <button
                    className="w-full rounded-sm px-3 py-1.5 text-left text-sm hover:bg-accent transition-colors"
                    onClick={() => handleExport("account")}
                  >
                    Account Snapshots
                  </button>
                  <button
                    className="w-full rounded-sm px-3 py-1.5 text-left text-sm hover:bg-accent transition-colors"
                    onClick={() => handleExport("media")}
                  >
                    Media Data
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Profile header */}
      <ProfileHeader account={account} />

      {/* Tabs */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="media">Media</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 pt-4">
          <PostingFrequencyChart media={account.media} />
        </TabsContent>

        <TabsContent value="media" className="pt-4">
          <MediaTable media={account.media} />
        </TabsContent>

        <TabsContent value="insights" className="pt-4">
          <InsightsPanel accountId={account.id} media={account.media} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
