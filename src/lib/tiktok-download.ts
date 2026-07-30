import { prisma } from "./db";
import { getMonthKey } from "./utils";

// TikTok-specific key override, mirroring IG_RAPIDAPI_KEY: lets an instance
// point TikTok at a different RapidAPI subscription than Instagram/Threads.
// Falls back to RAPIDAPI_KEY when unset, so existing instances are unchanged.
const RAPIDAPI_KEY = process.env.TIKTOK_RAPIDAPI_KEY || process.env.RAPIDAPI_KEY!;
const TIKTOK_HOST = process.env.TIKTOK_RAPIDAPI_HOST || "tiktok-api23.p.rapidapi.com";
const BASE_URL = `https://${TIKTOK_HOST}`;

// The provider's /api/download/video endpoint is flaky: roughly two out of
// three calls answer 204 with an empty body even for a perfectly valid video.
// A short retry loop reliably turns that into a 200. Note each attempt — including
// the empty ones — counts against the separate download-endpoint quota (500/day),
// so keep the attempt count modest.
const RESOLVE_ATTEMPTS = 6;
const RESOLVE_RETRY_DELAY = 1200;

// Hosts we are willing to stream bytes from. The resolved links always live on
// TikTok's own CDN; restricting to these suffixes keeps /file from being turned
// into an open proxy.
const ALLOWED_CDN_SUFFIXES = [
  ".tiktokcdn.com",
  ".tiktokcdn-eu.com",
  ".tiktokcdn-us.com",
  ".tiktokv.com",
];

export function isAllowedCdnUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    return ALLOWED_CDN_SUFFIXES.some((s) => u.hostname.endsWith(s));
  } catch {
    return false;
  }
}

async function trackApiCall() {
  const month = getMonthKey();
  await prisma.apiUsage.upsert({
    where: { month },
    update: { callCount: { increment: 1 } },
    create: { month, callCount: 1 },
  });
}

export interface TikTokDownloadInfo {
  sourceUrl: string;
  videoId: string;
  author: string;
  title: string;
  coverUrl: string;
  duration: number;
  /** Direct mp4, no watermark. */
  play: string;
  /** Direct mp4 with the TikTok watermark burned in. */
  playWatermark: string;
  /** Downloads left on the provider's daily download-endpoint quota. */
  quotaRemaining: number | null;
}

/**
 * Normalizes whatever the user pasted into a canonical video URL.
 * Strips tracking params (`?is_from_webapp=...`) which the provider chokes on,
 * and leaves short links (vm.tiktok.com/...) untouched so the API can resolve them.
 */
export function normalizeTikTokUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return trimmed;
  }
}

export function extractVideoId(url: string): string {
  const m = url.match(/\/video\/(\d+)/) || url.match(/\/photo\/(\d+)/);
  return m ? m[1] : "";
}

export function extractAuthor(url: string): string {
  const m = url.match(/@([\w.\-]+)/);
  return m ? m[1] : "";
}

/** Metadata (title/cover/duration) — served off the cheap 200k/month quota. */
async function fetchDetail(videoId: string): Promise<{
  title: string;
  author: string;
  coverUrl: string;
  duration: number;
}> {
  const fallback = { title: "", author: "", coverUrl: "", duration: 0 };
  if (!videoId) return fallback;

  try {
    await trackApiCall();
    const res = await fetch(`${BASE_URL}/api/post/detail?videoId=${encodeURIComponent(videoId)}`, {
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": TIKTOK_HOST,
      },
    });
    if (!res.ok) return fallback;

    const data = (await res.json()) as {
      itemInfo?: { itemStruct?: Record<string, unknown> };
    };
    const item = data.itemInfo?.itemStruct;
    if (!item) return fallback;

    const video = (item.video as Record<string, unknown>) || {};
    const author = (item.author as Record<string, unknown>) || {};
    return {
      title: (item.desc as string) || "",
      author: (author.uniqueId as string) || "",
      coverUrl: (video.cover as string) || "",
      duration: (video.duration as number) || 0,
    };
  } catch {
    return fallback;
  }
}

/**
 * Resolves a TikTok URL to directly downloadable mp4 links.
 *
 * The `hd=1` parameter is required — without it the endpoint answers 204 with an
 * empty body every single time.
 */
export async function resolveTikTokDownload(rawUrl: string): Promise<TikTokDownloadInfo> {
  const sourceUrl = normalizeTikTokUrl(rawUrl);
  if (!sourceUrl) throw new Error("Empty URL");
  if (!/tiktok\.com/i.test(sourceUrl)) {
    throw new Error("Not a TikTok link");
  }

  let quotaRemaining: number | null = null;
  let payload: { play?: string; play_watermark?: string } | null = null;

  for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt++) {
    await trackApiCall();
    const endpoint =
      `${BASE_URL}/api/download/video` +
      `?url=${encodeURIComponent(sourceUrl)}&hd=1`;

    const res = await fetch(endpoint, {
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": TIKTOK_HOST,
        "Content-Type": "application/json",
      },
    });

    const remainingHeader = res.headers.get("x-ratelimit-download-endpoints-remaining");
    if (remainingHeader !== null) quotaRemaining = Number(remainingHeader);

    if (res.status === 403) {
      throw new Error("This RapidAPI key is not subscribed to the TikTok API");
    }

    if (res.ok) {
      const text = await res.text();
      if (text.trim()) {
        payload = JSON.parse(text) as { play?: string; play_watermark?: string };
        if (payload.play || payload.play_watermark) break;
      }
    }

    // 204 / empty body → provider hiccup, try again.
    if (attempt < RESOLVE_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, RESOLVE_RETRY_DELAY));
    }
  }

  if (!payload?.play && !payload?.play_watermark) {
    throw new Error(
      `Provider did not return a download link after ${RESOLVE_ATTEMPTS} attempts (video may be private, removed, or region-locked)`,
    );
  }

  const videoId = extractVideoId(sourceUrl);
  const detail = await fetchDetail(videoId);

  return {
    sourceUrl,
    videoId,
    author: detail.author || extractAuthor(sourceUrl),
    title: detail.title,
    coverUrl: detail.coverUrl,
    duration: detail.duration,
    play: payload.play || payload.play_watermark || "",
    playWatermark: payload.play_watermark || "",
    quotaRemaining,
  };
}

/** Builds a filesystem-friendly `author - title [id].mp4` name. */
export function buildFileName(info: Pick<TikTokDownloadInfo, "author" | "title" | "videoId">): string {
  const slug = (info.title || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\p{L}\p{N} _.-]/gu, "")
    .trim()
    .slice(0, 60)
    .trim();
  const parts = [info.author && `@${info.author}`, slug, info.videoId && `[${info.videoId}]`]
    .filter(Boolean)
    .join(" ");
  return `${parts || "tiktok"}.mp4`;
}
