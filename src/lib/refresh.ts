import { prisma } from "./db";
import { fetchProfile, fetchAllStubs, fetchLatestStubs, dateFromMediaPk } from "./instagram-api";

// Confirms a suspected ban using the profile endpoint. The profile endpoint
// is the most reliable signal we have but is NOT bulletproof under load —
// during heavy bulk-refresh bursts it can return "data not found" for
// accounts that are actually alive. To avoid false positives, we require
// TWO separate "data not found" responses with a delay between them. If
// either probe shows the account is alive (or the API is unreachable), we
// refuse to mark banned.
async function probeProfileMissing(username: string): Promise<"missing" | "alive" | "inconclusive"> {
  try {
    await fetchProfile(username);
    return "alive";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Profile not found") || msg.includes("data not found")) {
      return "missing";
    }
    return "inconclusive";
  }
}

async function confirmBannedViaProfile(username: string): Promise<boolean> {
  const first = await probeProfileMissing(username);
  if (first !== "missing") {
    if (first === "inconclusive") {
      console.warn(`[banCheck] @${username}: first probe inconclusive — leaving status untouched`);
    }
    return false;
  }

  // First probe says missing — wait, then re-check before committing. The
  // delay matters: a burst-induced false negative usually clears within a
  // few seconds once the burst subsides.
  await new Promise((r) => setTimeout(r, 8000));
  const second = await probeProfileMissing(username);

  if (second === "missing") {
    console.log(`[banCheck] @${username}: confirmed missing on both probes → banned`);
    return true;
  }

  console.warn(`[banCheck] @${username}: first probe said missing but second said ${second} — likely API glitch, NOT marking banned`);
  return false;
}

export interface RefreshProgress {
  total: number;
  completed: number;
  current: string | null;
  errors: Array<{ username: string; error: string }>;
  running: boolean;
}

interface MediaStub {
  igMediaId: string;
  shortcode: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

async function upsertStubsAndSnapshots(
  accountId: string,
  stubs: MediaStub[],
) {
  for (const stub of stubs) {
    const existing = await prisma.media.findUnique({
      where: { igMediaId: stub.igMediaId },
    });

    let mediaId: string;

    if (existing) {
      mediaId = existing.id;
      if (!existing.publishedAt) {
        const derivedDate = dateFromMediaPk(stub.igMediaId);
        if (derivedDate) {
          await prisma.media.update({
            where: { id: existing.id },
            data: { publishedAt: derivedDate },
          });
        }
      }
    } else {
      const created = await prisma.media.create({
        data: {
          accountId,
          igMediaId: stub.igMediaId,
          mediaType: "REEL",
          shortcode: stub.shortcode,
          caption: "",
          thumbnailUrl: "",
          videoUrl: "",
          duration: 0,
          publishedAt: dateFromMediaPk(stub.igMediaId),
        },
      });
      mediaId = created.id;
    }

    const lastSnapshot = await prisma.mediaSnapshot.findFirst({
      where: { mediaId },
      orderBy: { snapshotAt: "desc" },
    });

    const metricsChanged =
      !lastSnapshot ||
      lastSnapshot.viewCount !== stub.viewCount ||
      lastSnapshot.likeCount !== stub.likeCount ||
      lastSnapshot.commentCount !== stub.commentCount;

    if (metricsChanged) {
      await prisma.mediaSnapshot.create({
        data: {
          mediaId,
          viewCount: stub.viewCount,
          likeCount: stub.likeCount,
          commentCount: stub.commentCount,
          engagementRate: 0,
        },
      });
    }
  }
}

export async function initialImport(username: string): Promise<string> {
  let profile;
  try {
    profile = await fetchProfile(username);
  } catch (err) {
    console.error(`[initialImport] @${username}: fetchProfile failed —`, err);
    await prisma.trackedAccount.update({
      where: { username },
      data: { status: "possibly_banned", lastRefreshedAt: new Date() },
    });
    const existing = await prisma.trackedAccount.findUnique({ where: { username } });
    return existing?.id || "";
  }

  // Don't overwrite a sticky "possibly_banned" status on re-import.
  const account = await prisma.trackedAccount.upsert({
    where: { username: profile.username },
    update: {
      igUserId: profile.igUserId,
      fullName: profile.fullName,
      bio: profile.bio,
      profilePicUrl: profile.profilePicUrl,
      isVerified: profile.isVerified,
      lastRefreshedAt: new Date(),
    },
    create: {
      igUserId: profile.igUserId,
      username: profile.username,
      fullName: profile.fullName,
      bio: profile.bio,
      profilePicUrl: profile.profilePicUrl,
      isVerified: profile.isVerified,
      status: "active",
      lastRefreshedAt: new Date(),
    },
  });

  await prisma.accountSnapshot.create({
    data: {
      accountId: account.id,
      followerCount: profile.followerCount,
      followingCount: profile.followingCount,
      mediaCount: profile.mediaCount,
    },
  });

  let stubs: MediaStub[] = [];
  try {
    stubs = await fetchAllStubs(username, 50);
  } catch (err) {
    console.error(`[initialImport] @${username}: stubs fetch failed —`, err);
  }

  if (stubs.length > 0) {
    await upsertStubsAndSnapshots(account.id, stubs);
  }

  // Profile already confirmed alive above — don't infer a ban from 0 reels
  // here, the reels endpoint is too flaky. Real bans get caught by
  // fetchProfile's throw at the top of this function (catch block).
  console.log(`[initialImport] @${username}: saved ${stubs.length} reels from stubs`);

  return account.id;
}

export async function refreshAccount(accountId: string): Promise<void> {
  const account = await prisma.trackedAccount.findUnique({
    where: { id: accountId },
    include: { _count: { select: { media: true } } },
  });

  if (!account) {
    console.log(`[refreshAccount] Account ${accountId} not found, skipping`);
    return;
  }

  let stubs: MediaStub[] = [];
  let fetchFailed = false;

  try {
    stubs = account._count.media === 0
      ? await fetchAllStubs(account.username, 50)
      : await fetchLatestStubs(account.username);
  } catch (err) {
    console.error(`[refreshAccount] @${account.username}: fetch failed —`, err);
    fetchFailed = true;
  }

  if (stubs.length > 0) {
    await upsertStubsAndSnapshots(accountId, stubs);
  }

  // Reels endpoint returning 0 (or failing) is NOT enough to conclude banned —
  // it's flaky enough at scale to produce many false positives on accounts
  // that have substantial media history. Only confirm via the profile
  // endpoint, which reliably returns "data not found" for vanished profiles.
  let isBanned = false;
  if ((fetchFailed || stubs.length === 0) && account.status !== "possibly_banned") {
    isBanned = await confirmBannedViaProfile(account.username);
  }

  // Status is sticky: once marked "possibly_banned" it stays that way until manually cleared.
  // Only upgrade to "possibly_banned"; never auto-clear back to "active".
  const updateData: { lastRefreshedAt: Date; status?: string } = {
    lastRefreshedAt: new Date(),
  };
  if (isBanned && account.status !== "possibly_banned") {
    updateData.status = "possibly_banned";
    console.log(`[refreshAccount] @${account.username}: status → possibly_banned`);
  }

  console.log(`[refreshAccount] @${account.username}: saved ${stubs.length} reels from stubs`);

  await prisma.trackedAccount.update({
    where: { id: accountId },
    data: updateData,
  });
}
