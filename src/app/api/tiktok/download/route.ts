import { NextRequest, NextResponse } from "next/server";
import { resolveTikTokDownload, buildFileName, TikTokDownloadInfo } from "@/lib/tiktok-download";

export const dynamic = "force-dynamic";

// Resolving burns the provider's small daily download quota (500/day, and every
// retried 204 counts too), so keep batches conservative.
const MAX_URLS = 20;

export interface ResolvedItem extends Partial<TikTokDownloadInfo> {
  input: string;
  fileName?: string;
  error?: string;
}

/**
 * POST /api/tiktok/download  { urls: string[] }
 *
 * Resolves each TikTok link to direct mp4 URLs. The actual bytes are then pulled
 * through GET /api/tiktok/download/file, which costs no extra API quota.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { urls?: string[] } | null;
  const urls = (body?.urls || []).map((u) => u.trim()).filter(Boolean);

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
      const info = await resolveTikTokDownload(input);
      results.push({ ...info, input, fileName: buildFileName(info) });
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
