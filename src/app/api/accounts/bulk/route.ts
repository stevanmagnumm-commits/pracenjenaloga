import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { initialImport } from "@/lib/refresh";
import { parseInstagramUrl } from "@/lib/utils";
import { addToSchedulerWithExpiry } from "@/lib/scheduler-add";

interface BulkProgress {
  total: number;
  completed: number;
  current: string | null;
  successes: string[];
  errors: Array<{ username: string; error: string }>;
  running: boolean;
}

let bulkProgress: BulkProgress = {
  total: 0,
  completed: 0,
  current: null,
  successes: [],
  errors: [],
  running: false,
};

export async function POST(request: NextRequest) {
  if (bulkProgress.running) {
    return NextResponse.json(
      { error: "Bulk import already in progress" },
      { status: 409 }
    );
  }

  const body = await request.json();
  const { usernames: raw, refreshInterval, priority, postsLeft } = body as {
    usernames: string[];
    refreshInterval?: string;
    priority?: number;
    postsLeft?: number | null;
  };

  const parsed = raw
    .map((u: string) => parseInstagramUrl(u))
    .filter((u): u is string => u !== null);

  const uniqueUsernames = [...new Set(parsed)];

  const existing = await prisma.trackedAccount.findMany({
    where: { username: { in: uniqueUsernames } },
    select: { username: true },
  });
  const existingSet = new Set(existing.map((e) => e.username));
  const newUsernames = uniqueUsernames.filter((u) => !existingSet.has(u));

  if (newUsernames.length === 0) {
    return NextResponse.json({
      message: `All ${existingSet.size} accounts are already tracked`,
      total: 0,
      skipped: existingSet.size,
    });
  }

  // Pre-create all accounts immediately so they show in the UI right away
  for (const username of newUsernames) {
    await prisma.trackedAccount.upsert({
      where: { username },
      update: {},
      create: {
        username,
        fullName: "",
        bio: "",
        isVerified: false,
        ...(refreshInterval && { refreshInterval }),
        ...(priority && { priority }),
      },
    });
  }

  bulkProgress = {
    total: newUsernames.length,
    completed: 0,
    current: null,
    successes: [],
    errors: [],
    running: true,
  };

  (async () => {
    for (const username of newUsernames) {
      bulkProgress.current = username;
      try {
        const accountId = await initialImport(username);
        if (refreshInterval || priority) {
          await prisma.trackedAccount.update({
            where: { id: accountId },
            data: {
              ...(refreshInterval && { refreshInterval }),
              ...(priority && { priority }),
            },
          });
        }
        if (typeof postsLeft === "number") {
          try {
            const result = await addToSchedulerWithExpiry(username, postsLeft);
            if (result) {
              console.log(`[bulk scheduler-add] @${username} → ${result.category} (avg36=${result.avg ?? "-"})`);
            }
          } catch (err) {
            console.error(`[bulk scheduler-add] Failed for @${username}:`, err);
          }
        }
        bulkProgress.successes.push(username);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`[bulk] Failed to import @${username}:`, message);
        bulkProgress.errors.push({ username, error: message });
      }
      bulkProgress.completed++;
    }
    bulkProgress.current = null;
    bulkProgress.running = false;
  })();

  return NextResponse.json({
    message: `Started importing ${newUsernames.length} accounts (${existingSet.size} already tracked)`,
    total: newUsernames.length,
    skipped: existingSet.size,
  });
}

export async function GET() {
  return NextResponse.json(bulkProgress);
}
