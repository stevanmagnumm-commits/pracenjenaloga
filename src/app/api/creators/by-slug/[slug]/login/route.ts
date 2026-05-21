import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  issueCreatorToken,
  creatorCookieName,
  CREATOR_COOKIE_MAX_AGE,
} from "@/lib/creator-auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const body = await request.json().catch(() => ({}));
  const { username, password } = body as { username?: string; password?: string };
  if (!username || !password) {
    return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
  }

  const creator = await prisma.creator.findUnique({
    where: { slug },
    select: { id: true, accessUsername: true, accessPassword: true },
  });
  if (!creator) return NextResponse.json({ error: "Sheet not found" }, { status: 404 });
  if (!creator.accessUsername || !creator.accessPassword) {
    return NextResponse.json({ error: "Sheet has no shared credentials configured" }, { status: 403 });
  }
  if (creator.accessUsername !== username || creator.accessPassword !== password) {
    return NextResponse.json({ error: "Wrong username or password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: creatorCookieName(creator.id),
    value: issueCreatorToken(creator.id),
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: CREATOR_COOKIE_MAX_AGE,
  });
  return res;
}
