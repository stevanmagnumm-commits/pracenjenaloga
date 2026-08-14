import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { canAccessCreator, isAdmin } from "@/lib/creator-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/creators/by-slug/<slug>
 *
 * Served by nginx WITHOUT basic auth (the shared sheet needs it), so it
 * authorizes here. Two rules:
 *
 *  1. Only the admin or a visitor logged into THIS sheet gets a response —
 *     the sheet component only ever calls this after the login gate on
 *     /creators/<slug>, so nothing legitimate breaks.
 *  2. accessUsername / accessPassword are the sheet's own shared login. They
 *     are returned to the admin only; handing them to the caller would mean
 *     anyone who guessed a slug could read the credentials for it.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const creator = await prisma.creator.findUnique({
    where: { slug },
    include: { _count: { select: { accounts: true } } },
  });
  if (!creator) {
    return NextResponse.json({ error: "Creator not found" }, { status: 404 });
  }

  if (!(await canAccessCreator(creator.id))) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  if (await isAdmin()) {
    return NextResponse.json(creator);
  }

  return NextResponse.json({
    id: creator.id,
    name: creator.name,
    slug: creator.slug,
    color: creator.color,
    createdAt: creator.createdAt,
    updatedAt: creator.updatedAt,
    _count: creator._count,
  });
}
