import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { groupId, usernames } = (await request.json()) as {
    groupId: string;
    usernames: string[];
  };

  if (!groupId || !usernames?.length) {
    return NextResponse.json({ error: "groupId and usernames required" }, { status: 400 });
  }

  const cleaned = usernames
    .map((u) => u.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(cleaned)];

  const accounts = await prisma.snapchatAccount.findMany({
    where: { username: { in: unique } },
    select: { id: true, username: true },
  });

  const foundSet = new Set(accounts.map((a) => a.username));
  const notFound = unique.filter((u) => !foundSet.has(u));

  let added = 0;
  for (const a of accounts) {
    try {
      await prisma.snapchatGroupMember.create({
        data: { groupId, accountId: a.id },
      });
      added++;
    } catch {
      // already in group
    }
  }

  return NextResponse.json({
    added,
    alreadyInGroup: accounts.length - added,
    notFound,
  });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const groupId = searchParams.get("groupId");
  const accountId = searchParams.get("accountId");

  if (!groupId || !accountId) {
    return NextResponse.json({ error: "groupId and accountId required" }, { status: 400 });
  }

  await prisma.snapchatGroupMember.deleteMany({ where: { groupId, accountId } });
  return NextResponse.json({ success: true });
}
