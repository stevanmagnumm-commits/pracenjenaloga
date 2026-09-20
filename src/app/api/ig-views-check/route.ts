import { NextRequest, NextResponse } from "next/server";
import {
  runIgViewsCheck,
  getIgViewsCheckProgress,
  stopIgViewsCheck,
  getResumableViewsCheck,
  resumeIgViewsCheck,
} from "@/lib/ig-views-check";
import { getApiRateUsage } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const progress = getIgViewsCheckProgress();
  if (progress.running) {
    return NextResponse.json(
      { error: "Check already in progress", progress },
      { status: 409 },
    );
  }

  const { usernames, resume } = (await request.json()) as {
    usernames?: string[];
    resume?: boolean;
  };

  // Continue a list a restart cut off, without re-grading anyone.
  if (resume) {
    const started = await resumeIgViewsCheck();
    if (!started) {
      return NextResponse.json({ error: "Nothing to resume" }, { status: 409 });
    }
    return NextResponse.json({ message: "Resumed", progress: getIgViewsCheckProgress() });
  }

  if (!usernames?.length) {
    return NextResponse.json({ error: "Usernames required" }, { status: 400 });
  }

  // Fire and forget — the UI polls GET for progress, same as the ban checker.
  runIgViewsCheck(usernames);

  return NextResponse.json({
    message: `Started checking ${usernames.length} accounts`,
    progress: getIgViewsCheckProgress(),
  });
}

export async function GET() {
  return NextResponse.json(
    {
      ...getIgViewsCheckProgress(),
      resumable: await getResumableViewsCheck(),
      rate: getApiRateUsage(),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function DELETE() {
  stopIgViewsCheck();
  return NextResponse.json({ message: "Check stopped" });
}
