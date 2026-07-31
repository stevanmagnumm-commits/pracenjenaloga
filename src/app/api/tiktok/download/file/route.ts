import { NextRequest, NextResponse } from "next/server";
import { isAllowedCdnUrl } from "@/lib/tiktok-download";
import { streamViaYtDlp } from "@/lib/tiktok-ytdlp";

export const dynamic = "force-dynamic";

/**
 * GET /api/tiktok/download/file
 *
 * Two ways in, matching the two resolvers:
 *   ?url=<tiktok page url>  → yt-dlp streams the mp4 straight through (default)
 *   ?src=<tiktok cdn url>   → proxied fetch, used by the RapidAPI fallback
 *
 * Both inputs are whitelisted by host so this can't be turned into an open proxy.
 */
export async function GET(request: NextRequest) {
  const pageUrl = request.nextUrl.searchParams.get("url") || "";
  const src = request.nextUrl.searchParams.get("src") || "";
  const name = request.nextUrl.searchParams.get("name") || "tiktok.mp4";

  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Content-Disposition": contentDisposition(name),
    "Cache-Control": "no-store",
  });

  if (pageUrl) {
    try {
      // Length is unknown up front here, so the browser shows an indeterminate
      // progress bar. Worth it to avoid buffering the whole file server-side.
      const stream = await streamViaYtDlp(pageUrl);
      return new NextResponse(stream, { status: 200, headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Download failed";
      const rejected = /^Not a (TikTok link|valid URL)$/.test(message);
      return NextResponse.json({ error: message }, { status: rejected ? 400 : 502 });
    }
  }

  if (!isAllowedCdnUrl(src)) {
    return NextResponse.json({ error: "Invalid or disallowed source URL" }, { status: 400 });
  }

  const upstream = await fetch(src, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://www.tiktok.com/",
    },
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: `Upstream returned ${upstream.status}` }, { status: 502 });
  }

  headers.set("Content-Type", upstream.headers.get("content-type") || "video/mp4");
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);

  return new NextResponse(upstream.body, { status: 200, headers });
}

function contentDisposition(name: string): string {
  const safe = name.replace(/["\\\r\n]/g, "").slice(0, 150) || "tiktok.mp4";
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
