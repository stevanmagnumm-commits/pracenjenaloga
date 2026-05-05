import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { importThreadsAccount } from "@/lib/threads-refresh";
import { parseThreadsUrl } from "@/lib/utils";

export async function GET() {
  const accounts = await prisma.threadsAccount.findMany({
    include: {
      snapshots: {
        orderBy: { snapshotAt: "desc" },
        take: 1,
      },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });
  return NextResponse.json(accounts);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { input } = body as { input: string };

  const username = parseThreadsUrl(input);
  if (!username) {
    return NextResponse.json({ error: "Invalid Threads username or URL" }, { status: 400 });
  }

  const existing = await prisma.threadsAccount.findUnique({
    where: { username },
  });
  if (existing) {
    return NextResponse.json({ error: "Account already tracked", account: existing }, { status: 409 });
  }

  const account = await prisma.threadsAccount.create({
    data: { username },
  });

  importThreadsAccount(username).catch((error) => {
    console.error(`[threads:import] Failed for ${username}:`, error);
  });

  return NextResponse.json({ ...account, importing: true }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "Missing account id" }, { status: 400 });
  }

  await prisma.threadsFollowerSnapshot.deleteMany({ where: { accountId: id } });
  await prisma.threadsAccount.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
