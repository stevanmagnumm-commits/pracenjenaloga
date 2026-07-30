import { NextRequest, NextResponse } from "next/server";
import { isAllowedCdnUrl } from "@/lib/tiktok-download";

export const dynamic = "force-dynamic";

/**
 * GET /api/tiktok/download/file?src=<cdn url>&name=<file name>
 *
 * Streams an already-resolved TikTok CDN mp4 back to the browser as an
 * attachment. Going through the server (rather than linking straight to the CDN)
 * lets us set a proper filename and avoids the browser hitting CDN links that
 * only answer to server-side requests. Costs no RapidAPI quota.
 */
export async function GET(request: NextRequest) {
  const src = request.nextUrl.searchParams.get("src") || "";
  const name = request.nextUrl.searchParams.get("name") || "tiktok.mp4";

  // `src` comes back from the client, so re-validate it here: only TikTok CDN
  // hosts are streamable, otherwise this route would be an open proxy.
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
    return NextResponse.json(
      { error: `Upstream returned ${upstream.status}` },
      { status: 502 },
    );
  }

  const safeName = name.replace(/["\\\r\n]/g, "").slice(0, 150) || "tiktok.mp4";
  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") || "video/mp4",
    "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    "Cache-Control": "no-store",
  });
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);

  return new NextResponse(upstream.body, { status: 200, headers });
}
