import { prisma } from "./db";
import { fetchThreadsProfile } from "./threads-api";

const RATE_LIMIT_DELAY_MS = 1300;

export interface ThreadsRefreshProgress {
  total: number;
  completed: number;
  current: string | null;
  errors: Array<{ username: string; error: string }>;
  running: boolean;
}

let currentProgress: ThreadsRefreshProgress = {
  total: 0,
  completed: 0,
  current: null,
  errors: [],
  running: false,
};

export function getThreadsRefreshProgress(): ThreadsRefreshProgress {
  return { ...currentProgress };
}

export async function importThreadsAccount(username: string): Promise<string> {
  const profile = await fetchThreadsProfile(username);

  const account = await prisma.threadsAccount.upsert({
    where: { username: profile.username },
    update: {
      threadsPk: profile.pk,
      fullName: profile.fullName,
      bio: profile.bio,
      isVerified: profile.isVerified,
      followerCount: profile.followerCount,
      lastRefreshedAt: new Date(),
    },
    create: {
      threadsPk: profile.pk,
      username: profile.username,
      fullName: profile.fullName,
      bio: profile.bio,
      isVerified: profile.isVerified,
      followerCount: profile.followerCount,
      lastRefreshedAt: new Date(),
    },
  });

  await prisma.threadsFollowerSnapshot.create({
    data: {
      accountId: account.id,
      followerCount: profile.followerCount,
    },
  });

  return account.id;
}

export async function refreshThreadsAccount(accountId: string): Promise<void> {
  const account = await prisma.threadsAccount.findUniqueOrThrow({
    where: { id: accountId },
  });

  const profile = await fetchThreadsProfile(account.username);

  await prisma.threadsAccount.update({
    where: { id: accountId },
    data: {
      followerCount: profile.followerCount,
      fullName: profile.fullName,
      bio: profile.bio,
      isVerified: profile.isVerified,
      lastRefreshedAt: new Date(),
    },
  });

  const lastSnapshot = await prisma.threadsFollowerSnapshot.findFirst({
    where: { accountId },
    orderBy: { snapshotAt: "desc" },
  });

  if (!lastSnapshot || lastSnapshot.followerCount !== profile.followerCount) {
    await prisma.threadsFollowerSnapshot.create({
      data: {
        accountId,
        followerCount: profile.followerCount,
      },
    });
  }
}

function getRefreshIntervalMs(interval: string): number {
  switch (interval) {
    case "ONE_HOUR": return 60 * 60 * 1000;
    case "EIGHT_HOURS": return 8 * 60 * 60 * 1000;
    case "TWELVE_HOURS": return 12 * 60 * 60 * 1000;
    case "DAILY": return 24 * 60 * 60 * 1000;
    default: return 8 * 60 * 60 * 1000;
  }
}

export async function refreshAllThreadsDue(): Promise<ThreadsRefreshProgress> {
  if (currentProgress.running) {
    return currentProgress;
  }

  const accounts = await prisma.threadsAccount.findMany({
    orderBy: [{ priority: "asc" }, { lastRefreshedAt: "asc" }],
  });

  const dueAccounts = accounts.filter((acc) => {
    if (!acc.lastRefreshedAt) return true;
    const intervalMs = getRefreshIntervalMs(acc.refreshInterval);
    return Date.now() - acc.lastRefreshedAt.getTime() > intervalMs;
  });

  currentProgress = {
    total: dueAccounts.length,
    completed: 0,
    current: null,
    errors: [],
    running: true,
  };

  for (const account of dueAccounts) {
    currentProgress.current = account.username;
    try {
      await refreshThreadsAccount(account.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      currentProgress.errors.push({ username: account.username, error: message });
    }
    currentProgress.completed++;
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
  }

  currentProgress.current = null;
  currentProgress.running = false;

  return { ...currentProgress };
}
