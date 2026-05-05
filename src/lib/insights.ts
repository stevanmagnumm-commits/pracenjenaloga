import { prisma } from "./db";

export interface PostingTimeHeatmap {
  day: number; // 0=Sunday, 6=Saturday
  hour: number; // 0-23
  count: number;
  avgEngagement: number;
}

export interface DurationBucket {
  label: string;
  minSeconds: number;
  maxSeconds: number;
  count: number;
  avgViews: number;
  avgEngagement: number;
}

export interface AccountInsights {
  bestPostingTimes: PostingTimeHeatmap[];
  bestVideoLengths: DurationBucket[];
  avgEngagementRate: number;
  totalViews: number;
  totalMedia: number;
  postingFrequency: number; // posts per week
}

export async function getAccountInsights(accountId: string): Promise<AccountInsights> {
  const media = await prisma.media.findMany({
    where: { accountId },
    include: {
      snapshots: {
        orderBy: { snapshotAt: "desc" },
        take: 1,
      },
    },
  });

  const heatmapMap = new Map<string, { count: number; totalER: number }>();
  const durationBuckets: Array<{ min: number; max: number; label: string }> = [
    { min: 0, max: 15, label: "0-15s" },
    { min: 15, max: 30, label: "15-30s" },
    { min: 30, max: 60, label: "30-60s" },
    { min: 60, max: 90, label: "60-90s" },
    { min: 90, max: Infinity, label: "90s+" },
  ];
  const bucketStats = durationBuckets.map((b) => ({
    ...b,
    count: 0,
    totalViews: 0,
    totalER: 0,
  }));

  let totalER = 0;
  let totalViews = 0;
  let mediaWithStats = 0;

  for (const item of media) {
    const snapshot = item.snapshots[0];
    if (!snapshot) continue;

    mediaWithStats++;
    totalER += snapshot.engagementRate;
    totalViews += snapshot.viewCount;

    if (item.publishedAt) {
      const date = new Date(item.publishedAt);
      const day = date.getUTCDay();
      const hour = date.getUTCHours();
      const key = `${day}-${hour}`;
      const existing = heatmapMap.get(key) || { count: 0, totalER: 0 };
      existing.count++;
      existing.totalER += snapshot.engagementRate;
      heatmapMap.set(key, existing);
    }

    if (item.duration && item.duration > 0) {
      for (const bucket of bucketStats) {
        if (item.duration >= bucket.min && item.duration < bucket.max) {
          bucket.count++;
          bucket.totalViews += snapshot.viewCount;
          bucket.totalER += snapshot.engagementRate;
          break;
        }
      }
    }
  }

  const bestPostingTimes: PostingTimeHeatmap[] = [];
  for (const [key, value] of heatmapMap) {
    const [day, hour] = key.split("-").map(Number);
    bestPostingTimes.push({
      day,
      hour,
      count: value.count,
      avgEngagement: value.count > 0 ? value.totalER / value.count : 0,
    });
  }
  bestPostingTimes.sort((a, b) => b.avgEngagement - a.avgEngagement);

  const bestVideoLengths: DurationBucket[] = bucketStats.map((b) => ({
    label: b.label,
    minSeconds: b.min,
    maxSeconds: b.max,
    count: b.count,
    avgViews: b.count > 0 ? Math.round(b.totalViews / b.count) : 0,
    avgEngagement: b.count > 0 ? b.totalER / b.count : 0,
  }));

  const firstPost = media
    .filter((m) => m.publishedAt)
    .sort((a, b) => (a.publishedAt!.getTime() - b.publishedAt!.getTime()))[0];
  const lastPost = media
    .filter((m) => m.publishedAt)
    .sort((a, b) => (b.publishedAt!.getTime() - a.publishedAt!.getTime()))[0];

  let postingFrequency = 0;
  if (firstPost?.publishedAt && lastPost?.publishedAt) {
    const weeks =
      (lastPost.publishedAt.getTime() - firstPost.publishedAt.getTime()) /
      (7 * 24 * 60 * 60 * 1000);
    if (weeks > 0) {
      postingFrequency = Math.round((media.length / weeks) * 10) / 10;
    }
  }

  return {
    bestPostingTimes,
    bestVideoLengths,
    avgEngagementRate: mediaWithStats > 0 ? totalER / mediaWithStats : 0,
    totalViews,
    totalMedia: media.length,
    postingFrequency,
  };
}

export async function getGrowthRate(
  accountId: string,
  days: number = 30
): Promise<{ startFollowers: number; endFollowers: number; growthPercent: number; dataPoints: Array<{ date: string; followers: number }> }> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const snapshots = await prisma.accountSnapshot.findMany({
    where: { accountId, snapshotAt: { gte: since } },
    orderBy: { snapshotAt: "asc" },
  });

  if (snapshots.length < 2) {
    const latest = snapshots[0];
    return {
      startFollowers: latest?.followerCount || 0,
      endFollowers: latest?.followerCount || 0,
      growthPercent: 0,
      dataPoints: snapshots.map((s) => ({
        date: s.snapshotAt.toISOString().split("T")[0],
        followers: s.followerCount,
      })),
    };
  }

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const growthPercent =
    first.followerCount > 0
      ? ((last.followerCount - first.followerCount) / first.followerCount) * 100
      : 0;

  return {
    startFollowers: first.followerCount,
    endFollowers: last.followerCount,
    growthPercent: Math.round(growthPercent * 100) / 100,
    dataPoints: snapshots.map((s) => ({
      date: s.snapshotAt.toISOString().split("T")[0],
      followers: s.followerCount,
    })),
  };
}
