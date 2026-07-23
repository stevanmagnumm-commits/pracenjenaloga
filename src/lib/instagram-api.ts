import { prisma } from "./db";
import { getMonthKey } from "./utils";
import type {
  NormalizedProfile,
  NormalizedMedia,
} from "@/types/instagram";

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY!;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || "instagram-scraper-stable-api.p.rapidapi.com";
const BASE_URL = `https://${RAPIDAPI_HOST}`;
const RATE_DELAY = 800;

// Which IG data provider this instance talks to:
//   "stable"       → instagram-scraper-stable-api (POST endpoints, default)
//   "mediacrawlers"→ instagram-api-fast-reliable-data-scraper (GET endpoints)
// Both are normalized to the same NormalizedProfile / MediaStub shapes below so
// the rest of the app is provider-agnostic.
const IG_PROVIDER = (process.env.IG_PROVIDER || "stable").toLowerCase();

async function trackApiCall() {
  const month = getMonthKey();
  await prisma.apiUsage.upsert({
    where: { month },
    update: { callCount: { increment: 1 } },
    create: { month, callCount: 1 },
  });
}

// On 429 (burst rate limit) we back off and retry several times — RapidAPI's
// per-second cap clears in a couple of seconds, so a short wait usually wins.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 40_000];

async function retryWait(status: number, attempt: number, endpoint: string, retryAfterHeader: string | null) {
  // Honor Retry-After header if the server provides one (in seconds)
  let waitMs = RETRYABLE_BACKOFF_MS[Math.min(attempt, RETRYABLE_BACKOFF_MS.length - 1)];
  if (retryAfterHeader) {
    const ra = Number(retryAfterHeader);
    if (Number.isFinite(ra) && ra > 0) waitMs = Math.max(waitMs, ra * 1000);
  }
  console.log(`[api] ${status} on ${endpoint}, retry ${attempt + 1} in ${waitMs}ms`);
  await new Promise((r) => setTimeout(r, waitMs));
}

async function apiPost(endpoint: string, body: Record<string, string>, retries = 5): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await trackApiCall();
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });
    if (response.ok) return response.json();
    if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
      await retryWait(response.status, attempt, endpoint, response.headers.get("retry-after"));
      continue;
    }
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  throw new Error("Unreachable");
}

async function apiGet(endpoint: string, retries = 5): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await trackApiCall();
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: "GET",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
      },
    });
    if (response.ok) return response.json();
    if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
      await retryWait(response.status, attempt, endpoint, response.headers.get("retry-after"));
      continue;
    }
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  throw new Error("Unreachable");
}

// ---------------------------------------------------------------------------
// mediacrawlers provider (instagram-api-fast-reliable-data-scraper)
// GET endpoints; returns the raw parsed body plus HTTP status so callers can
// distinguish a real "not found" (404) from a transient error / rate limit.
// ---------------------------------------------------------------------------
async function mcGet(
  path: string,
  retries = 5,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await trackApiCall();
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "GET",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
      },
    });
    if (response.ok) {
      return { ok: true, status: response.status, data: (await response.json()) as Record<string, unknown> };
    }
    if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
      await retryWait(response.status, attempt, path, response.headers.get("retry-after"));
      continue;
    }
    let data: Record<string, unknown> = {};
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = { raw: await response.text().catch(() => "") };
    }
    return { ok: false, status: response.status, data };
  }
  return { ok: false, status: 0, data: {} };
}

function mcIsMissing(status: number, data: Record<string, unknown>): boolean {
  if (status === 404) return true;
  const err = String(data.error || data.message || "").toLowerCase();
  return /couldn't find|couldn.t find|not found|does not exist|user not found/.test(err);
}

async function fetchProfileMediacrawlers(username: string): Promise<NormalizedProfile> {
  const res = await mcGet(`/profile?username=${encodeURIComponent(username)}`);

  if (!res.ok) {
    // A genuine "account is gone" signal → let callers mark it banned/missing.
    if (mcIsMissing(res.status, res.data)) {
      throw new Error(`Profile not found: @${username} (${res.data.error || res.status})`);
    }
    // Rate limit (403 "reached requests limit"), 5xx, etc. → transient/unknown.
    throw new Error(`API error ${res.status}: ${JSON.stringify(res.data)}`);
  }

  const user = res.data;
  // Some providers return HTTP 200 with an { error } body for missing accounts.
  if (user.error || (!user.pk && !user.username)) {
    throw new Error(`Profile not found: @${username} (${user.error || "empty response"})`);
  }

  return {
    igUserId: String(user.pk || user.id || ""),
    username: (user.username as string) || username,
    fullName: (user.full_name as string) || "",
    bio: (user.biography as string) || "",
    profilePicUrl: (user.profile_pic_url as string) || "",
    isVerified: (user.is_verified as boolean) || false,
    followerCount: (user.follower_count as number) || 0,
    followingCount: (user.following_count as number) || 0,
    mediaCount: (user.media_count as number) || 0,
  };
}

async function fetchUserIdMediacrawlers(username: string): Promise<string> {
  const res = await mcGet(`/user_id_by_username?username=${encodeURIComponent(username)}`);
  if (!res.ok) {
    if (mcIsMissing(res.status, res.data)) {
      throw new Error(`Profile not found: @${username} (${res.data.error || res.status})`);
    }
    throw new Error(`API error ${res.status}: ${JSON.stringify(res.data)}`);
  }
  const uid = res.data.UserID ?? res.data.user_id ?? res.data.pk ?? res.data.id;
  if (!uid) throw new Error(`user_id not found for @${username}`);
  return String(uid);
}

async function fetchReelStubsMediacrawlers(username: string, maxStubs: number): Promise<MediaStub[]> {
  const userId = await fetchUserIdMediacrawlers(username);
  const byId = new Map<string, MediaStub>();
  let maxId: string | undefined;

  while (byId.size < maxStubs) {
    let path = `/reels?user_id=${encodeURIComponent(userId)}`;
    if (maxId) path += `&max_id=${encodeURIComponent(maxId)}`;

    const res = await mcGet(path);
    if (!res.ok) {
      console.error(`[stubs:reels:mc] @${username} HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 160)}`);
      break;
    }

    const data = ((res.data.data as Record<string, unknown>) || res.data) as Record<string, unknown>;
    const items = (data.items as Array<Record<string, unknown>>) || [];

    let newCount = 0;
    for (const it of items) {
      const m = ((it.media as Record<string, unknown>) || it) as Record<string, unknown>;
      const pk = String(m.pk || m.id || "");
      const code = (m.code as string) || "";
      if (!pk || !code) continue;
      if (byId.size >= maxStubs) break;
      if (!byId.has(pk)) {
        byId.set(pk, {
          igMediaId: pk,
          shortcode: code,
          viewCount: (m.play_count as number) || (m.ig_play_count as number) || (m.view_count as number) || 0,
          likeCount: (m.like_count as number) || 0,
          commentCount: (m.comment_count as number) || 0,
        });
        newCount++;
      }
    }

    const paging = ((data.paging_info as Record<string, unknown>) || data) as Record<string, unknown>;
    const moreAvailable = paging.more_available as boolean | undefined;
    maxId = (paging.max_id as string) || (paging.next_max_id as string) || undefined;

    console.log(`[stubs:reels:mc] @${username} ${items.length} items, ${newCount} new, ${byId.size} total (max ${maxStubs})`);
    if (!moreAvailable || !maxId || newCount === 0 || byId.size >= maxStubs) break;
    await new Promise((r) => setTimeout(r, RATE_DELAY));
  }

  return Array.from(byId.values());
}

export function dateFromMediaPk(pk: string): Date | null {
  try {
    const ts = Number(BigInt(pk) >> BigInt(23)) + 1314220021721;
    const d = new Date(ts);
    if (d.getFullYear() > 2010 && d.getFullYear() < 2100) return d;
  } catch {}
  return null;
}

export async function fetchProfile(username: string): Promise<NormalizedProfile> {
  if (IG_PROVIDER === "mediacrawlers") {
    return fetchProfileMediacrawlers(username);
  }

  const user = await apiPost("/ig_get_fb_profile_v3.php", {
    username_or_url: username,
  }) as Record<string, unknown>;

  // The API returns HTTP 200 with {"error":"data not found"} for banned/missing
  // accounts. Treat that as a hard failure so callers can mark them banned.
  if (user.error || (!user.pk && !user.id && !user.username)) {
    throw new Error(`Profile not found: @${username} (${user.error || "empty response"})`);
  }

  return {
    igUserId: String(user.pk || user.id || ""),
    username: (user.username as string) || username,
    fullName: (user.full_name as string) || "",
    bio: (user.biography as string) || "",
    profilePicUrl: (user.profile_pic_url as string) || "",
    isVerified: (user.is_verified as boolean) || false,
    followerCount: (user.follower_count as number) || 0,
    followingCount: (user.following_count as number) || 0,
    mediaCount: (user.media_count as number) || 0,
  };
}

interface MediaStub {
  igMediaId: string;
  shortcode: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

async function fetchReelStubsPageOnce(username: string, paginationToken?: string): Promise<{ stubs: MediaStub[]; nextCursor?: string }> {
  const body: Record<string, string> = { username_or_url: username };
  if (paginationToken) body.pagination_token = paginationToken;

  const data = await apiPost("/get_ig_user_reels.php", body) as Record<string, unknown>;
  const reels = (data.reels as Array<Record<string, unknown>>) || [];

  const stubs: MediaStub[] = [];
  for (const reel of reels) {
    const m = (reel.node as Record<string, unknown>)?.media as Record<string, unknown>;
    if (!m) continue;
    const pk = String(m.pk || m.id || "");
    const code = (m.code as string) || "";
    if (!pk || !code) continue;
    stubs.push({
      igMediaId: pk,
      shortcode: code,
      viewCount: (m.play_count as number) || (m.view_count as number) || 0,
      likeCount: (m.like_count as number) || 0,
      commentCount: (m.comment_count as number) || 0,
    });
  }

  const rawToken = (data.pagination_token as string) || "";
  const nextCursor = rawToken.length > 10 && stubs.length > 0 ? rawToken : undefined;
  return { stubs, nextCursor };
}

async function fetchReelStubsPage(username: string, paginationToken?: string): Promise<{ stubs: MediaStub[]; nextCursor?: string }> {
  const first = await fetchReelStubsPageOnce(username, paginationToken);
  // Only the first page (no cursor) is retried — an empty first page usually
  // means either "banned" or a transient API glitch, and we want to
  // disambiguate before any ban-detection heuristic acts on it.
  if (first.stubs.length > 0 || paginationToken) return first;
  console.log(`[stubs:reels] @${username} returned 0 on first try, retrying once…`);
  await new Promise((r) => setTimeout(r, 1500));
  const second = await fetchReelStubsPageOnce(username, paginationToken);
  if (second.stubs.length > 0) {
    console.log(`[stubs:reels] @${username} retry recovered ${second.stubs.length} items`);
  }
  return second;
}

export async function fetchAllStubs(username: string, maxStubs = 50): Promise<MediaStub[]> {
  if (IG_PROVIDER === "mediacrawlers") {
    return fetchReelStubsMediacrawlers(username, maxStubs);
  }

  const byId = new Map<string, MediaStub>();
  let cursor: string | undefined;

  while (byId.size < maxStubs) {
    try {
      const { stubs, nextCursor } = await fetchReelStubsPage(username, cursor);
      let newCount = 0;
      for (const s of stubs) {
        if (byId.size >= maxStubs) break;
        if (!byId.has(s.igMediaId)) {
          byId.set(s.igMediaId, s);
          newCount++;
        } else {
          byId.get(s.igMediaId)!.viewCount = Math.max(byId.get(s.igMediaId)!.viewCount, s.viewCount);
        }
      }
      console.log(`[stubs:reels] ${stubs.length} items, ${newCount} new, ${byId.size} total (max ${maxStubs})`);
      if (!nextCursor || newCount === 0 || byId.size >= maxStubs) break;
      cursor = nextCursor;
      await new Promise((r) => setTimeout(r, RATE_DELAY));
    } catch (err) {
      console.error(`[stubs:reels] Error fetching page, stopping pagination with ${byId.size} stubs:`, err);
      break;
    }
  }

  return Array.from(byId.values());
}

// During regular refreshes we pull the latest ~36 reels (3 pages of 12). This
// gives a stable rolling-window average and catches new reels even when an
// account posts a burst between refreshes. Initial import still uses 50 via
// fetchAllStubs.
export async function fetchLatestStubs(username: string, maxStubs = 36): Promise<MediaStub[]> {
  return fetchAllStubs(username, maxStubs);
}

async function fetchMediaDetailOnce(shortcode: string): Promise<NormalizedMedia | null> {
  // The mediacrawlers /reels feed already carries view/like/comment counts, so
  // per-media enrichment isn't needed there (and its media-detail endpoint has a
  // different shape). Skip gracefully — callers treat null as "use stub values".
  if (IG_PROVIDER === "mediacrawlers") return null;

  const item = await apiGet(`/get_media_data_v2.php?media_code=${encodeURIComponent(shortcode)}`) as Record<string, unknown>;
  if (item.error) return null;

  const captionEdges = item.edge_media_to_caption as Record<string, unknown> | undefined;
  const edges = (captionEdges?.edges as Array<Record<string, unknown>>) || [];
  const captionNode = edges[0]?.node as Record<string, unknown> | undefined;
  const captionText = (captionNode?.text as string) || "";

  const takenAt = item.taken_at_timestamp as number | undefined;

  let mediaType: "REEL" | "IMAGE" | "CAROUSEL" | "VIDEO";
  if ((item.product_type as string) === "clips") {
    mediaType = "REEL";
  } else if (item.is_video) {
    mediaType = "VIDEO";
  } else {
    mediaType = "IMAGE";
  }

  const likeData = item.edge_media_preview_like as Record<string, unknown> | undefined;
  const commentData = item.edge_media_to_parent_comment as Record<string, unknown> | undefined;

  return {
    igMediaId: String(item.id || ""),
    mediaType,
    shortcode: (item.shortcode as string) || shortcode,
    caption: captionText,
    thumbnailUrl: (item.thumbnail_src as string) || (item.display_url as string) || "",
    videoUrl: (item.video_url as string) || "",
    duration: (item.video_duration as number) || 0,
    publishedAt: takenAt ? new Date(takenAt * 1000) : null,
    viewCount: (item.video_play_count as number) || (item.video_view_count as number) || 0,
    likeCount: (likeData?.count as number) || 0,
    commentCount: (commentData?.count as number) || 0,
  };
}

export async function fetchMediaDetail(shortcode: string): Promise<NormalizedMedia | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await fetchMediaDetailOnce(shortcode);
      if (result) return result;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

function enrichStub(stub: MediaStub, detail: NormalizedMedia | null): NormalizedMedia {
  if (detail) {
    return {
      ...detail,
      igMediaId: stub.igMediaId,
      publishedAt: detail.publishedAt || dateFromMediaPk(stub.igMediaId),
      viewCount: Math.max(stub.viewCount, detail.viewCount),
      likeCount: Math.max(stub.likeCount, detail.likeCount),
      commentCount: Math.max(stub.commentCount, detail.commentCount),
      thumbnailUrl: detail.thumbnailUrl || "",
    };
  }
  return {
    igMediaId: stub.igMediaId,
    shortcode: stub.shortcode,
    mediaType: "REEL",
    caption: "",
    thumbnailUrl: "",
    videoUrl: "",
    duration: 0,
    publishedAt: dateFromMediaPk(stub.igMediaId),
    viewCount: stub.viewCount,
    likeCount: stub.likeCount,
    commentCount: stub.commentCount,
  };
}

export async function fetchFullMedia(stubs: MediaStub[]): Promise<NormalizedMedia[]> {
  const results: NormalizedMedia[] = [];
  console.log(`[fetchFullMedia] Enriching ${stubs.length} items via get_media_data_v2...`);

  for (let i = 0; i < stubs.length; i++) {
    const stub = stubs[i];
    try {
      const detail = await fetchMediaDetail(stub.shortcode);
      results.push(enrichStub(stub, detail));
    } catch (err) {
      console.error(`[fetchFullMedia] Failed to enrich ${stub.shortcode}:`, err);
      results.push(enrichStub(stub, null));
    }

    if ((i + 1) % 10 === 0) console.log(`[fetchFullMedia] ${i + 1}/${stubs.length} done`);
    if (i < stubs.length - 1) await new Promise((r) => setTimeout(r, RATE_DELAY));
  }

  const withDate = results.filter((r) => r.publishedAt).length;
  console.log(`[fetchFullMedia] Done. ${withDate}/${results.length} have dates`);
  return results;
}

export async function fetchFullMediaStreaming(
  stubs: MediaStub[],
  onItem: (item: NormalizedMedia) => Promise<void>,
): Promise<number> {
  console.log(`[fetchFullMedia] Enriching ${stubs.length} items via get_media_data_v2...`);
  let saved = 0;

  for (let i = 0; i < stubs.length; i++) {
    const stub = stubs[i];
    try {
      const detail = await fetchMediaDetail(stub.shortcode);
      const item = enrichStub(stub, detail);
      await onItem(item);
      saved++;
    } catch (err) {
      console.error(`[fetchFullMedia] Failed to enrich ${stub.shortcode}:`, err);
      try {
        await onItem(enrichStub(stub, null));
        saved++;
      } catch {}
    }

    if ((i + 1) % 10 === 0) console.log(`[fetchFullMedia] ${i + 1}/${stubs.length} done`);
    if (i < stubs.length - 1) await new Promise((r) => setTimeout(r, RATE_DELAY));
  }

  console.log(`[fetchFullMedia] Done. ${saved}/${stubs.length} saved`);
  return saved;
}

export async function getApiUsage(): Promise<{ month: string; callCount: number }> {
  const month = getMonthKey();
  const usage = await prisma.apiUsage.findUnique({ where: { month } });
  return { month, callCount: usage?.callCount || 0 };
}
