import { NextRequest, NextResponse } from "next/server";
import { resolveTikTokDownload, buildFileName, TikTokDownloadInfo } from "@/lib/tiktok-download";

export const dynamic = "force-dynamic";

// Only relevant to the RapidAPI fallback, whose daily download quota is 500 (and
// every retried 204 counts too). The yt-dlp path has no such ceiling.
const MAX_URLS = 20;

export interface ResolvedItem extends Partial<TikTokDownloadInfo> {
  input: string;
  fileName?: string;
  /** Ready-to-use href for the streaming route, empty when resolving failed. */
  downloadUrl?: string;
  error?: string;
}

/**
 * POST /api/tiktok/download  { urls: string[], watermark?: boolean }
 *
 * Resolves each TikTok link into metadata plus a `downloadUrl` pointing at
 * GET /api/tiktok/download/file, which is where the bytes actually come from.
 *
 * The UI posts one link per request and renders results as they land: on the
 * RapidAPI fallback a single link can take ~20s (the provider has to be retried
 * through its random empty responses), so a whole batch in one request would blow
 * past nginx's 60s proxy timeout.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    urls?: string[];
    watermark?: boolean;
  } | null;
  const urls = (body?.urls || []).map((u) => u.trim()).filter(Boolean);
  const watermark = body?.watermark === true;

  if (urls.length === 0) {
    return NextResponse.json({ error: "urls[] required" }, { status: 400 });
  }
  if (urls.length > MAX_URLS) {
    return NextResponse.json(
      { error: `Maximum ${MAX_URLS} links at a time` },
      { status: 400 },
    );
  }

  const results: ResolvedItem[] = [];

  for (const input of urls) {
    try {
      const info = await resolveTikTokDownload(input, { watermark });
      const fileName = buildFileName(info);
      results.push({ ...info, input, fileName, downloadUrl: buildDownloadUrl(info, fileName, watermark) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[tiktok:download] ${input}: ${message}`);
      results.push({ input, error: message });
    }
  }

  const quotaRemaining =
    [...results].reverse().find((r) => typeof r.quotaRemaining === "number")?.quotaRemaining ?? null;

  return NextResponse.json({ results, quotaRemaining });
}

function buildDownloadUrl(info: TikTokDownloadInfo, fileName: string, watermark: boolean): string {
  const name = `name=${encodeURIComponent(fileName)}`;
  if (info.source === "ytdlp") {
    return `/api/tiktok/download/file?url=${encodeURIComponent(info.sourceUrl)}&${name}`;
  }
  const src = watermark && info.playWatermark ? info.playWatermark : info.play;
  return src ? `/api/tiktok/download/file?src=${encodeURIComponent(src)}&${name}` : "";
}
