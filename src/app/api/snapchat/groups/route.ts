import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const groups = await prisma.snapchatGroup.findMany({
    include: { _count: { select: { members: true } } },
    orderBy: { name: "asc" },
  });

  return NextResponse.json(
    groups.map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g._count.members,
    })),
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(request: NextRequest) {
  const { name } = (await request.json()) as { name: string };
  if (!name?.trim()) {
    return NextResponse.json({ error: "Name required" }, { status: 400 });
  }

  const existing = await prisma.snapchatGroup.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return NextResponse.json({ error: "Group already exists" }, { status: 409 });
  }

  const group = await prisma.snapchatGroup.create({ data: { name: name.trim() } });
  return NextResponse.json(group);
}

export async function DELETE(request: NextRequest) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await prisma.snapchatGroup.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
