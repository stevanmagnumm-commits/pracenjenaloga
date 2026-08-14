import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  issueCreatorToken,
  creatorCookieName,
  safeEqual,
  COOKIE_SECURE,
  CREATOR_COOKIE_MAX_AGE,
} from "@/lib/creator-auth";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Brute-force throttle
//
// This is the one credential check that nginx does NOT see: the fail2ban
// nginx-http-auth jail only watches basic-auth failures, and a wrong password
// here is just a 401 JSON body it ignores. Without a limit an attacker could
// grind the 12-character shared password at full request rate.
//
// State is per-process and resets on restart, which is fine — a restart is
// rare and an attacker cannot trigger one.
// ---------------------------------------------------------------------------
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

const failures = new Map<string, { count: number; firstAt: number }>();

/**
 * nginx sets X-Real-IP on every proxied request, and the app ports (3000-3002)
 * are blocked by ufw, so nginx is the only way in and the header cannot be
 * spoofed from outside.
 */
function clientIp(request: NextRequest): string {
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

function throttled(key: string): boolean {
  const now = Date.now();
  // Opportunistic prune so the map can't grow without bound.
  if (failures.size > 5_000) {
    for (const [k, v] of failures) {
      if (now - v.firstAt > WINDOW_MS) failures.delete(k);
    }
  }
  const entry = failures.get(key);
  if (!entry) return false;
  if (now - entry.firstAt > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(key: string) {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count++;
}

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const body = await request.json().catch(() => ({}));
  const { username, password } = body as { username?: string; password?: string };
  if (!username || !password) {
    return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
  }

  const throttleKey = `${clientIp(request)}|${slug}`;
  if (throttled(throttleKey)) {
    console.warn(`[creator-login] throttled ${throttleKey}`);
    return NextResponse.json(
      { error: "Too many failed attempts. Try again in 15 minutes." },
      { status: 429 },
    );
  }

  const creator = await prisma.creator.findUnique({
    where: { slug },
    select: { id: true, accessUsername: true, accessPassword: true },
  });
  if (!creator) return NextResponse.json({ error: "Sheet not found" }, { status: 404 });
  if (!creator.accessUsername || !creator.accessPassword) {
    return NextResponse.json({ error: "Sheet has no shared credentials configured" }, { status: 403 });
  }
  // Both compared in constant time, and both evaluated so a wrong username
  // doesn't return measurably faster than a wrong password.
  const userOk = safeEqual(creator.accessUsername, username);
  const passOk = safeEqual(creator.accessPassword, password);
  if (!userOk || !passOk) {
    recordFailure(throttleKey);
    return NextResponse.json({ error: "Wrong username or password" }, { status: 401 });
  }

  failures.delete(throttleKey);

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: creatorCookieName(creator.id),
    value: issueCreatorToken(creator.id),
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: CREATOR_COOKIE_MAX_AGE,
  });
  return res;
}
