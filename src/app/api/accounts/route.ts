import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { initialImport } from "@/lib/refresh";

export const dynamic = "force-dynamic";
import { parseInstagramUrl } from "@/lib/utils";

export async function GET() {
  const accounts = await prisma.trackedAccount.findMany({
    include: {
      snapshots: {
        orderBy: { snapshotAt: "desc" },
        take: 1,
      },
      _count: {
        select: { media: true },
      },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });

  return NextResponse.json(accounts);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { input, refreshInterval, priority } = body as {
    input: string;
    refreshInterval?: string;
    priority?: number;
  };

  const username = parseInstagramUrl(input);
  if (!username) {
    return NextResponse.json({ error: "Invalid Instagram URL or username" }, { status: 400 });
  }

  const existing = await prisma.trackedAccount.findUnique({
    where: { username },
  });
  if (existing) {
    return NextResponse.json({ error: "Account already tracked", account: existing }, { status: 409 });
  }

  // Create the account record immediately so the UI can show it
  const account = await prisma.trackedAccount.create({
    data: {
      igUserId: "",
      username,
      fullName: "",
      bio: "",
      isVerified: false,
    },
  });

  if (refreshInterval || priority) {
    await prisma.trackedAccount.update({
      where: { id: account.id },
      data: {
        ...(refreshInterval && { refreshInterval }),
        ...(priority && { priority }),
      },
    });
  }

  // Run the import in the background (don't await)
  initialImport(username).catch((error) => {
    console.error(`[initialImport] Failed for ${username}:`, error);
  });

  return NextResponse.json(
    { ...account, _count: { media: 0 }, importing: true },
    { status: 201 }
  );
}

export async function PATCH(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing account id" }, { status: 400 });
  }
  
  const body = await request.json();
  const { note } = body as { note?: string | null };
  
  const updated = await prisma.trackedAccount.update({
    where: { id },
    data: {
      ...(note !== undefined && { note: note || null }),
    },
  });
  
  return NextResponse.json(updated);
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "Missing account id" }, { status: 400 });
  }

  const account = await prisma.trackedAccount.findUnique({
    where: { id },
    select: { username: true },
  });

  await prisma.mediaSnapshot.deleteMany({
    where: { media: { accountId: id } },
  });
  await prisma.media.deleteMany({ where: { accountId: id } });
  await prisma.accountSnapshot.deleteMany({ where: { accountId: id } });
  await prisma.trackedAccount.delete({ where: { id } });

  // Also remove the scheduler entry so orphans don't pile up.
  if (account) {
    await prisma.scheduleEntry.deleteMany({ where: { username: account.username } });
  }

  return NextResponse.json({ success: true });
}
