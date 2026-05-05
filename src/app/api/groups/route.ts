import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const groups = await prisma.accountGroup.findMany({
    include: {
      _count: { select: { members: true } },
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json(
    groups.map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g._count.members,
      createdAt: g.createdAt,
    })),
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name } = body as { name: string };

  if (!name?.trim()) {
    return NextResponse.json({ error: "Group name is required" }, { status: 400 });
  }

  const existing = await prisma.accountGroup.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return NextResponse.json({ error: "Group already exists" }, { status: 409 });
  }

  const group = await prisma.accountGroup.create({
    data: { name: name.trim() },
  });

  return NextResponse.json(group);
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "Group id is required" }, { status: 400 });
  }

  await prisma.accountGroup.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
