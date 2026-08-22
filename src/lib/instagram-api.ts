import { prisma } from "./db";
import { getMonthKey } from "./utils";
import type {
  NormalizedProfile,
  NormalizedMedia,
} from "@/types/instagram";

// IG-specific key override: lets an instance point Instagram at a different
// RapidAPI subscription than TikTok/Threads (which keep using RAPIDAPI_KEY).
// Falls back to RAPIDAPI_KEY when unset, so existing instances are unchanged.
const RAPIDAPI_KEY = process.env.IG_RAPIDAPI_KEY || process.env.RAPIDAPI_KEY!;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || "instagram-scraper-stable-api.p.rapidapi.com";
const BASE_URL = `https://${RAPIDAPI_HOST}`;
const RATE_DELAY = 800;

// Which IG data provider this instance talks to:
//   "stable"       → instagram-scraper-stable-api (POST endpoints, default)
//   "mediacrawlers"→ instagram-api-fast-reliable-data-scraper (GET endpoints)
// Both are normalized to the same NormalizedProfile / MediaStub shapes below so
// the rest of the app is provider-agnostic.
const IG_PROVIDER = (process.env.IG_PROVIDER || "stable").toLowerCase();

// Deliberately NOT awaited by callers.
//
// This is one row that every single API attempt writes to, so six workers plus
// the cron jobs all queue behind the same SQLite write lock. Making an outbound
// HTTP request wait on that lock puts a database stall directly in the path of
// every scrape — and a stalled counter update should never be able to stop the
// work it is only counting. Losing a few increments if the process dies is a
// far cheaper failure than a frozen run.
function trackApiCall() {
  const month = getMonthKey();
  prisma.apiUsage
    .upsert({
      where: { month },
      update: { callCount: { increment: 1 } },
      create: { month, callCount: 1 },
    })
    .catch((err) => {
      console.error("[api] usage counter write failed:", err instanceof Error ? err.message : err);
    });
}

// On 429 (burst rate limit) we back off and retry several times — RapidAPI's
// per-second cap clears in a couple of seconds, so a short wait usually wins.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 40_000];

// A request that timed out is not the same as being told to slow down. It has
// already burned the full deadline in silence, and sleeping another 40s on top
// is dead time that buys nothing — measured on a live run, 54 timeouts in six
// minutes while the checker sat at 40 of its 50 permitted calls per minute.
// Timeouts get a short ladder; only a real 429 (or 5xx) gets the long one.
const TIMEOUT_BACKOFF_MS = [1_000, 2_000, 3_000, 5_000, 8_000];

async function retryWait(status: number, attempt: number, endpoint: string, retryAfterHeader: string | null) {
  const ladder = status === TIMEOUT_STATUS ? TIMEOUT_BACKOFF_MS : RETRYABLE_BACKOFF_MS;
  // Honor Retry-After header if the server provides one (in seconds)
  let waitMs = ladder[Math.min(attempt, ladder.length - 1)];
  if (retryAfterHeader) {
    const ra = Number(retryAfterHeader);
    if (Number.isFinite(ra) && ra > 0) waitMs = Math.max(waitMs, ra * 1000);
  }
  console.log(`[api] ${status} on ${endpoint}, retry ${attempt + 1} in ${waitMs}ms`);
  await new Promise((r) => setTimeout(r, waitMs));
}

// A request that never answers is worse than one that fails outright: with no
// deadline on fetch(), a single hung call pins its caller indefinitely. Measured
// against the live provider while it was degraded, 4 of 6 probes were still
// waiting at 40s with no response at all. Cap the wait and let the retry ladder
// above treat it like any other transient failure.
const API_TIMEOUT_MS = Math.max(5_000, Number(process.env.IG_API_TIMEOUT_MS) || 20_000);
const TIMEOUT_STATUS = 408;

type FetchOutcome =
  | { ok: true; response: Response }
  | { ok: false; reason: string };

/**
 * The provider signals some transient failures with HTTP 200 and an error
 * payload instead of a status code. Observed live on get_ig_user_reels.php:
 *
 *   ["Some error occurred. Please try again later."]
 *
 * Callers read `data.reels`, find nothing, and conclude the account has no
 * reels — a failure silently becomes a fact. The same call answered with 12
 * reels seconds earlier. Empty and unparseable bodies land here too; both used
 * to escape the retry loop entirely (an unparseable body threw straight out of
 * response.json()). Treat all three as transient so the ladder retries them.
 */
type JsonOutcome = { ok: true; data: unknown } | { ok: false; reason: string };

async function readJsonBody(response: Response): Promise<JsonOutcome> {
  const text = await response.text();
  if (!text.trim()) return { ok: false, reason: "empty body" };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: `unparseable body: ${text.slice(0, 100)}` };
  }

  // Shape 1 — a bare array of strings:
  //   ["Some error occurred. Please try again later."]
  if (
    Array.isArray(data) &&
    data.length > 0 &&
    data.every((entry) => typeof entry === "string") &&
    /error occurred|try again|rate limit/i.test(data.join(" "))
  ) {
    return { ok: false, reason: (data as string[]).join(" ").slice(0, 120) };
  }

  // Shape 2 — the plan's per-minute cap, also served as HTTP 200:
  //   {"message":"You have exceeded the rate limit per minute for your plan..."}
  // This one is the expensive mistake: it has no `reels` key, so every caller
  // read it as "this account has no reels" and filed a live account as dead.
  //
  // Deliberately NOT matched: {"error":"data not found"}, which is the genuine
  // "this account is gone" answer the ban detection depends on.
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const message = (data as Record<string, unknown>).message;
    if (typeof message === "string" && /rate limit|exceeded|quota/i.test(message)) {
      return { ok: false, reason: message.slice(0, 120) };
    }
  }

  return { ok: true, data };
}

async function fetchWithDeadline(url: string, init: RequestInit): Promise<FetchOutcome> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    return { ok: true, response };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut =
      msg.includes("timed out") ||
      msg.includes("aborted") ||
      (err instanceof Error && err.name === "TimeoutError");
    return { ok: false, reason: timedOut ? `no response within ${API_TIMEOUT_MS}ms` : msg };
  }
}

async function apiPost(endpoint: string, body: Record<string, string>, retries = 5): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    trackApiCall();
    const outcome = await fetchWithDeadline(`${BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });
    if (!outcome.ok) {
      if (attempt < retries) {
        await retryWait(TIMEOUT_STATUS, attempt, endpoint, null);
        continue;
      }
      throw new Error(`API request failed: ${outcome.reason}`);
    }
    const response = outcome.response;
    if (response.ok) {
      const parsed = await readJsonBody(response);
      if (!parsed.ok) {
        if (attempt < retries) {
          // A per-minute cap needs a real pause, not the 2s a hiccup gets, so
          // it backs off on the 429 ladder rather than the transient one.
          const overCap = /rate limit|exceeded|quota/i.test(parsed.reason);
          await retryWait(overCap ? 429 : TIMEOUT_STATUS, attempt, endpoint, null);
          continue;
        }
        throw new Error(`API error body on ${endpoint}: ${parsed.reason}`);
      }
      return parsed.data;
    }
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
    trackApiCall();
    const outcome = await fetchWithDeadline(`${BASE_URL}${endpoint}`, {
      method: "GET",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
      },
    });
    if (!outcome.ok) {
      if (attempt < retries) {
        await retryWait(TIMEOUT_STATUS, attempt, endpoint, null);
        continue;
      }
      throw new Error(`API request failed: ${outcome.reason}`);
    }
    const response = outcome.response;
    if (response.ok) {
      const parsed = await readJsonBody(response);
      if (!parsed.ok) {
        if (attempt < retries) {
          // A per-minute cap needs a real pause, not the 2s a hiccup gets, so
          // it backs off on the 429 ladder rather than the transient one.
          const overCap = /rate limit|exceeded|quota/i.test(parsed.reason);
          await retryWait(overCap ? 429 : TIMEOUT_STATUS, attempt, endpoint, null);
          continue;
        }
        throw new Error(`API error body on ${endpoint}: ${parsed.reason}`);
      }
      return parsed.data;
    }
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
    trackApiCall();
    const outcome = await fetchWithDeadline(`${BASE_URL}${path}`, {
      method: "GET",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
      },
    });
    if (!outcome.ok) {
      if (attempt < retries) {
        await retryWait(TIMEOUT_STATUS, attempt, path, null);
        continue;
      }
      return { ok: false, status: TIMEOUT_STATUS, data: { error: outcome.reason } };
    }
    const response = outcome.response;
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
  // accounts. That explicit sentence is the ONLY thing allowed to mean "gone".
  const errText = typeof user.error === "string" ? user.error : "";
  if (errText) {
    if (/not found|does not exist|invalid username/i.test(errText)) {
      throw new Error(`Profile not found: @${username} (${errText})`);
    }
    throw new Error(`Profile error for @${username}: ${errText}`);
  }

  // Anything else unrecognisable is a broken answer, not a verdict. Calling it
  // "not found" here is exactly how a rate-limit body — served as HTTP 200 with
  // {"message":"You have exceeded the rate limit per minute for your plan"} and
  // no pk/id/username — turned live accounts into confirmed bans.
  if (!user.pk && !user.id && !user.username) {
    throw new Error(
      `Profile response unusable for @${username}: ${JSON.stringify(user).slice(0, 120)}`,
    );
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
  let pinnedSkipped = 0;
  for (const reel of reels) {
    const m = (reel.node as Record<string, unknown>)?.media as Record<string, unknown>;
    if (!m) continue;

    // A pinned reel sits at the top of the profile forever, so it keeps
    // accumulating views while the rest of the feed turns over. Averaging it in
    // lets one old viral clip speak for the account — the difference between
    // "this account does 14K" and "this account does 2.6M". Instagram marks them
    // with a non-empty clips_tab_pinned_user_ids; they are excluded from the
    // window entirely, exactly like the profile grid treats them separately.
    const pinnedFor = m.clips_tab_pinned_user_ids;
    if (Array.isArray(pinnedFor) && pinnedFor.length > 0) {
      pinnedSkipped++;
      continue;
    }

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

  if (pinnedSkipped > 0) {
    console.log(`[stubs:reels] @${username} skipped ${pinnedSkipped} pinned reel(s)`);
  }

  // Note the cursor check uses the RAW reel count, not `stubs`: a page made up
  // entirely of pinned reels is still a real page, and stopping there would cut
  // the window short.
  const rawToken = (data.pagination_token as string) || "";
  const nextCursor = rawToken.length > 10 && reels.length > 0 ? rawToken : undefined;
  return { stubs, nextCursor };
}

async function fetchReelStubsPage(username: string, paginationToken?: string): Promise<{ stubs: MediaStub[]; nextCursor?: string }> {
  const first = await fetchReelStubsPageOnce(username, paginationToken);
  // EVERY empty page is retried once, not just the first.
  //
  // An empty first page means either "gone" or a transient glitch, and that has
  // to be disambiguated before any ban heuristic acts on it. But an empty page
  // *mid-pagination* is just as suspect and used to be trusted outright: the
  // previous page handed back a real cursor, which the provider only issues
  // when there is more to come, so a sudden nothing is far more likely to be a
  // hiccup than the end of the feed. Trusting it cut the window short and
  // quietly moved the average — the same account graded 143 over 33 reels and
  // 92 over 12 twenty minutes apart, which is the difference between two
  // buckets. The average is the whole point of this number, so it is worth one
  // extra call to defend it.
  if (first.stubs.length > 0) return first;
  const where = paginationToken ? "mid-pagination" : "on the first page";
  console.log(`[stubs:reels] @${username} returned 0 ${where}, retrying once…`);
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
