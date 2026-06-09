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

export interface RefreshProgress {
  total: number;
  completed: number;
  current: string | null;
  errors: Array<{ username: string; error: string }>;
  running: boolean;
}

export type BanCheckResult = "alive" | "banned" | "inconclusive";

/**
 * Lightweight ban check for a single account. Hits ONLY the profile endpoint
 * (1 call, or 2 if the first says "missing" and we double-check) — no reels
 * fetching — so it's far cheaper than a full refresh. Updates status both ways:
 *   - confirmed missing  → possibly_banned
 *   - alive              → active  (clears a previous possibly_banned)
 *   - inconclusive       → left untouched
 */
export async function checkAccountBan(accountId: string): Promise<BanCheckResult> {
  const account = await prisma.trackedAccount.findUnique({
    where: { id: accountId },
    select: { id: true, username: true, status: true },
  });
  if (!account) return "inconclusive";

  const first = await probeProfileMissing(account.username);

  let result: BanCheckResult;
  if (first === "alive") {
    result = "alive";
  } else if (first === "inconclusive") {
    result = "inconclusive";
  } else {
    // First probe says missing — wait then re-check to avoid burst-induced
    // false positives, mirroring confirmBannedViaProfile.
    await new Promise((r) => setTimeout(r, 8000));
    const second = await probeProfileMissing(account.username);
    result = second === "missing" ? "banned" : second === "alive" ? "alive" : "inconclusive";
  }

  if (result === "banned" && account.status !== "possibly_banned") {
    await prisma.trackedAccount.update({
      where: { id: accountId },
      data: { status: "possibly_banned", lastRefreshedAt: new Date() },
    });
    console.log(`[checkBan] @${account.username}: → possibly_banned`);
  } else if (result === "alive" && account.status === "possibly_banned") {
    await prisma.trackedAccount.update({
      where: { id: accountId },
      data: { status: "active", lastRefreshedAt: new Date() },
    });
    console.log(`[checkBan] @${account.username}: recovered → active`);
  }

  return result;
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

  // Ban detection is intentionally NOT done here anymore — it added an 8s
  // profile re-probe per suspicious account and made bulk refresh crawl.
  // Use the dedicated "Check bans" action instead. We DO opportunistically
  // recover a previously-flagged account for free: if it now returns reels,
  // it's clearly alive, so clear the sticky possibly_banned flag.
  void fetchFailed;
  const updateData: { lastRefreshedAt: Date; status?: string } = {
    lastRefreshedAt: new Date(),
  };
  if (stubs.length > 0 && account.status === "possibly_banned") {
    updateData.status = "active";
    console.log(`[refreshAccount] @${account.username}: returned reels → recovered to active`);
  }

  console.log(`[refreshAccount] @${account.username}: saved ${stubs.length} reels from stubs`);

  await prisma.trackedAccount.update({
    where: { id: accountId },
    data: updateData,
  });
}
