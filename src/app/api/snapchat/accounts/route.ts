import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const groupId = req.nextUrl.searchParams.get("groupId");

  const whereClause = groupId ? { groups: { some: { groupId } } } : {};

  const accounts = await prisma.snapchatAccount.findMany({
    where: whereClause,
    include: {
      groups: { include: { group: { select: { id: true, name: true } } } },
    },
    orderBy: [{ status: "asc" }, { username: "asc" }],
  });

  const data = accounts.map((a) => ({
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    status: a.status,
    lastCheckedAt: a.lastCheckedAt,
    createdAt: a.createdAt,
    groups: a.groups.map((g) => ({ id: g.group.id, name: g.group.name })),
  }));

  return NextResponse.json(data, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { usernames, groupId } = body as { usernames: string[]; groupId?: string };

  if (!usernames?.length) {
    return NextResponse.json({ error: "Usernames required" }, { status: 400 });
  }

  const cleaned = usernames
    .map((u: string) => u.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(cleaned)];

  const existing = await prisma.snapchatAccount.findMany({
    where: { username: { in: unique } },
    select: { id: true, username: true },
  });
  const existingSet = new Set(existing.map((e) => e.username));
  const newUsernames = unique.filter((u) => !existingSet.has(u));

  const created: string[] = [];
  for (const username of newUsernames) {
    await prisma.snapchatAccount.create({ data: { username } });
    created.push(username);
  }

  if (groupId) {
    const allAccounts = await prisma.snapchatAccount.findMany({
      where: { username: { in: unique } },
      select: { id: true },
    });

    for (const acc of allAccounts) {
      await prisma.snapchatGroupMember.create({
        data: { groupId, accountId: acc.id },
      }).catch(() => {});
    }
  }

  return NextResponse.json({
    added: created.length,
    duplicates: existingSet.size,
    total: unique.length,
  });
}

export async function DELETE(request: NextRequest) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await prisma.snapchatAccount.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
