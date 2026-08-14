import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  generateCredentials,
  issueAdminToken,
  isAdmin,
  ADMIN_COOKIE,
  ADMIN_COOKIE_MAX_AGE,
  COOKIE_SECURE,
} from "@/lib/creator-auth";

// This whole path sits behind nginx basic auth (`location /`). GET additionally
// bootstraps the admin session cookie, so it cannot require one. The mutating
// handlers do require it — by then the admin panel has always called GET first.
const forbidden = () =>
  NextResponse.json({ error: "Not authorized" }, { status: 403 });

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "creator";
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let n = 2;
  while (await prisma.creator.findUnique({ where: { slug } })) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

export async function GET() {
  const creators = await prisma.creator.findMany({
    include: { _count: { select: { accounts: true } } },
    orderBy: { name: "asc" },
  });
  // Hitting this admin endpoint counts as being inside the main panel — issue
  // a long-lived admin session cookie so subsequent sheet views know we're the
  // owner (and not a Filipino who logged in via the per-creator credentials).
  const res = NextResponse.json(creators);
  res.cookies.set({
    name: ADMIN_COOKIE,
    value: issueAdminToken(),
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_COOKIE_MAX_AGE,
  });
  return res;
}

export async function POST(request: NextRequest) {
  if (!(await isAdmin())) return forbidden();

  const body = await request.json();
  const { name, color } = body as { name: string; color?: string };

  if (!name || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  const trimmed = name.trim();
  const slug = await uniqueSlug(slugify(trimmed));
  const creds = generateCredentials();

  try {
    const creator = await prisma.creator.create({
      data: {
        name: trimmed,
        slug,
        color: color || null,
        accessUsername: creds.username,
        accessPassword: creds.password,
      },
    });
    return NextResponse.json(creator, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create creator";
    if (msg.includes("Unique constraint")) {
      return NextResponse.json({ error: "A creator with this name already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!(await isAdmin())) return forbidden();

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const body = await request.json();
  const { name, color, accessUsername, accessPassword } = body as {
    name?: string;
    color?: string | null;
    accessUsername?: string | null;
    accessPassword?: string | null;
  };

  const updated = await prisma.creator.update({
    where: { id },
    data: {
      ...(name !== undefined && { name: name.trim() }),
      ...(color !== undefined && { color: color || null }),
      ...(accessUsername !== undefined && { accessUsername: accessUsername || null }),
      ...(accessPassword !== undefined && { accessPassword: accessPassword || null }),
    },
  });
  return NextResponse.json(updated);
}

export async function DELETE(request: NextRequest) {
  if (!(await isAdmin())) return forbidden();

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  await prisma.creator.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
