import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const groupId = request.nextUrl.searchParams.get("groupId");

  if (!groupId) {
    return NextResponse.json({ error: "groupId is required" }, { status: 400 });
  }

  const members = await prisma.accountGroupMember.findMany({
    where: { groupId },
    include: { account: { select: { id: true, username: true, fullName: true } } },
  });

  return NextResponse.json(
    members.map((m) => ({
      id: m.id,
      accountId: m.account.id,
      username: m.account.username,
      fullName: m.account.fullName,
    })),
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { groupId, usernames } = body as { groupId: string; usernames: string[] };

  if (!groupId || !usernames?.length) {
    return NextResponse.json({ error: "groupId and usernames are required" }, { status: 400 });
  }

  const cleaned = usernames
    .map((u) => u.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(cleaned)];

  const accounts = await prisma.trackedAccount.findMany({
    where: { username: { in: unique } },
    select: { id: true, username: true },
  });

  const foundSet = new Set(accounts.map((a) => a.username));
  const notFound = unique.filter((u) => !foundSet.has(u));

  const existing = await prisma.accountGroupMember.findMany({
    where: {
      groupId,
      accountId: { in: accounts.map((a) => a.id) },
    },
    select: { accountId: true },
  });
  const existingIds = new Set(existing.map((e) => e.accountId));

  const toAdd = accounts.filter((a) => !existingIds.has(a.id));

  for (const a of toAdd) {
    await prisma.accountGroupMember.create({
      data: { groupId, accountId: a.id },
    }).catch(() => {});
  }

  return NextResponse.json({
    added: toAdd.length,
    alreadyInGroup: existingIds.size,
    notFound,
  });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const groupId = searchParams.get("groupId");
  const accountId = searchParams.get("accountId");

  if (!groupId || !accountId) {
    return NextResponse.json({ error: "groupId and accountId are required" }, { status: 400 });
  }

  await prisma.accountGroupMember.deleteMany({
    where: { groupId, accountId },
  });

  return NextResponse.json({ success: true });
}
