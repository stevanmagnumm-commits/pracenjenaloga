import { prisma } from "./db";
import { getMonthKey } from "./utils";
import { isYtDlpAvailable, resolveViaYtDlp } from "./tiktok-ytdlp";

// TikTok-specific key override, mirroring IG_RAPIDAPI_KEY: lets an instance
// point TikTok at a different RapidAPI subscription than Instagram/Threads.
// Falls back to RAPIDAPI_KEY when unset, so existing instances are unchanged.
const RAPIDAPI_KEY = process.env.TIKTOK_RAPIDAPI_KEY || process.env.RAPIDAPI_KEY!;
const TIKTOK_HOST = process.env.TIKTOK_RAPIDAPI_HOST || "tiktok-api23.p.rapidapi.com";
const BASE_URL = `https://${TIKTOK_HOST}`;

// The provider's /api/download/video endpoint is flaky in a purely random way:
// it answers 204 with an empty body for perfectly valid, public videos. Measured
// on live links, the first 200 arrived on attempt 2, 6 and 11 respectively, so a
// short retry loop is not enough — anything under ~15 attempts leaves working
// videos reported as failures.
//
// Every attempt (including the empty ones) counts against the provider's separate
// download-endpoint quota of 500/day, which works out to roughly 100 videos a day.
const RESOLVE_ATTEMPTS = 15;
const RESOLVE_RETRY_DELAY = 800;

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
  /** Which backend produced this result — `ytdlp` costs no quota. */
  source: "ytdlp" | "api";
  /** Direct mp4, no watermark. Empty on the yt-dlp path, which streams instead. */
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

interface TikTokDetail {
  title: string;
  author: string;
  coverUrl: string;
  duration: number;
}

const EMPTY_DETAIL: TikTokDetail = { title: "", author: "", coverUrl: "", duration: 0 };

/**
 * Metadata (title/cover/duration), served off the cheap 200k/month quota.
 *
 * Doubles as an existence check: returns `null` only when the API positively says
 * there is no such video. That lets the caller reject dead links before spending
 * anything from the scarce 500/day download quota. Transient trouble yields an
 * empty detail instead, so a hiccup here never blocks a real download.
 */
async function fetchDetail(videoId: string): Promise<TikTokDetail | null> {
  if (!videoId) return EMPTY_DETAIL;

  try {
    await trackApiCall();
    const res = await fetch(`${BASE_URL}/api/post/detail?videoId=${encodeURIComponent(videoId)}`, {
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": TIKTOK_HOST,
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) return EMPTY_DETAIL;

    const data = (await res.json()) as {
      itemInfo?: { itemStruct?: Record<string, unknown> };
    };
    const item = data.itemInfo?.itemStruct;
    if (!item) return null;

    const video = (item.video as Record<string, unknown>) || {};
    const author = (item.author as Record<string, unknown>) || {};
    return {
      title: (item.desc as string) || "",
      author: (author.uniqueId as string) || "",
      coverUrl: (video.cover as string) || "",
      duration: (video.duration as number) || 0,
    };
  } catch {
    return EMPTY_DETAIL;
  }
}

/**
 * Resolves a TikTok URL for download.
 *
 * yt-dlp is tried first: it is free, unmetered, faster and yields the original
 * 1080p file. The RapidAPI provider is the fallback for when yt-dlp is missing or
 * TikTok has changed something the installed binary can't parse yet — and it is
 * the only path that can produce a watermarked file.
 */
export async function resolveTikTokDownload(
  rawUrl: string,
  opts: { watermark?: boolean } = {},
): Promise<TikTokDownloadInfo> {
  const sourceUrl = normalizeTikTokUrl(rawUrl);
  if (!sourceUrl) throw new Error("Empty URL");
  if (!/tiktok\.com/i.test(sourceUrl)) {
    throw new Error("Not a TikTok link");
  }

  if (!opts.watermark && (await isYtDlpAvailable())) {
    try {
      const info = await resolveViaYtDlp(sourceUrl);
      return {
        sourceUrl,
        videoId: info.videoId || extractVideoId(sourceUrl),
        author: info.author || extractAuthor(sourceUrl),
        title: info.title,
        coverUrl: info.coverUrl,
        duration: info.duration,
        source: "ytdlp",
        play: "",
        playWatermark: "",
        quotaRemaining: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A private or deleted video is a dead end — the provider can't help either,
      // and falling through would waste 15 download-quota calls confirming it.
      if (/private|unavailable|removed/i.test(message)) throw err;
      console.warn(`[tiktok:download] yt-dlp failed for ${sourceUrl} (${message}), using API`);
    }
  }

  // Confirm the video exists before touching the download quota — 15 retries
  // against a dead link would otherwise cost 3% of the daily budget to learn nothing.
  const videoId = extractVideoId(sourceUrl);
  const detail = await fetchDetail(videoId);
  if (detail === null) throw new Error("Video is unavailable or removed");

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
      `No download link after ${RESOLVE_ATTEMPTS} attempts — provider was unresponsive, try this link again`,
    );
  }

  return {
    sourceUrl,
    videoId,
    author: detail.author || extractAuthor(sourceUrl),
    title: detail.title,
    coverUrl: detail.coverUrl,
    duration: detail.duration,
    source: "api",
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
