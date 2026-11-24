import { NextRequest, NextResponse } from "next/server";
import {
  runIgViewsCheck,
  getIgViewsCheckProgress,
  stopIgViewsCheck,
  getResumableViewsCheck,
  resumeIgViewsCheck,
  runIgReelViewsCheck,
  parseReelLines,
} from "@/lib/ig-views-check";
import { getApiRateUsage, getLaneRateUsage } from "@/lib/rate-limit";
import { laneStatus } from "@/lib/api-lanes";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const progress = getIgViewsCheckProgress();
  if (progress.running) {
    return NextResponse.json(
      { error: "Check already in progress", progress },
      { status: 409 },
    );
  }

  const { usernames, reelLines, resume } = (await request.json()) as {
    usernames?: string[];
    /** Reel mode: the pasted lines, parsed here so there is one parser. */
    reelLines?: string[];
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

  // Reel mode: one row per pasted URL, graded on that reel alone.
  //
  // The lines are parsed here rather than in the browser so that the rule for
  // what counts as a reel URL lives in exactly one place - the server that has
  // to go and fetch it.
  if (reelLines?.length) {
    const { jobs, bad } = parseReelLines(reelLines);
    if (!jobs.length) {
      return NextResponse.json(
        {
          error:
            "No reel URL found in those lines. Each line needs an instagram.com/reel/... link.",
          badLines: bad.slice(0, 10),
        },
        { status: 400 },
      );
    }
    runIgReelViewsCheck(jobs);
    return NextResponse.json({
      message: `Started checking ${jobs.length} reel${jobs.length === 1 ? "" : "s"}`,
      // Said out loud rather than dropped: a line that was silently skipped is
      // a reel the user thinks was measured.
      skippedLines: bad,
      progress: getIgViewsCheckProgress(),
    });
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
      // A trickle has to be visible, or it reads as a freeze.
      lane: { ...getLaneRateUsage("views"), ...laneStatus("views") },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function DELETE() {
  stopIgViewsCheck();
  return NextResponse.json({ message: "Check stopped" });
}
