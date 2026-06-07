import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { initialImport } from "@/lib/refresh";

export const dynamic = "force-dynamic";

interface RetryProgress {
  total: number;
  completed: number;
  current: string | null;
  successes: string[];
  errors: { username: string; error: string }[];
  running: boolean;
}

let progress: RetryProgress = {
  total: 0,
  completed: 0,
  current: null,
  successes: [],
  errors: [],
  running: false,
};

/**
 * GET — returns live progress for a running retry job.
 */
export async function GET() {
  return NextResponse.json(progress);
}

/**
 * POST — finds every TrackedAccount with an empty igUserId (these are the
 * stubs left behind when the initial profile fetch failed mid-bulk-import)
 * and re-runs initialImport on each. The 429-retry logic in instagram-api.ts
 * now handles burst limits gracefully, so most stubs should fill in cleanly.
 *
 * Idempotent — re-running has no negative effect on already-completed
 * accounts because we never touch rows that have a non-empty igUserId.
 */
export async function POST(_request: NextRequest) {
  if (progress.running) {
    return NextResponse.json(
      { error: "A retry job is already running", progress },
      { status: 409 },
    );
  }

  const incomplete = await prisma.trackedAccount.findMany({
    where: { OR: [{ igUserId: "" }, { igUserId: null }] },
    select: { username: true },
    orderBy: { createdAt: "asc" },
  });

  if (incomplete.length === 0) {
    return NextResponse.json({ started: false, total: 0, message: "No incomplete accounts to retry." });
  }

  progress = {
    total: incomplete.length,
    completed: 0,
    current: null,
    successes: [],
    errors: [],
    running: true,
  };

  // Run in the background so the request returns immediately
  (async () => {
    for (const { username } of incomplete) {
      progress.current = username;
      try {
        await initialImport(username);
        progress.successes.push(username);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "unknown";
        console.error(`[retry-incomplete] @${username}:`, msg);
        progress.errors.push({ username, error: msg });
      }
      progress.completed++;
    }
    progress.current = null;
    progress.running = false;
    console.log(`[retry-incomplete] Done. ${progress.successes.length} succeeded, ${progress.errors.length} failed.`);
  })();

  return NextResponse.json({ started: true, total: incomplete.length });
}
