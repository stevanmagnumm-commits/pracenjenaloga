import { NextRequest, NextResponse } from "next/server";
import {
  runTrialCompare,
  getTrialCompareProgress,
  stopTrialCompare,
  parseTrialLines,
} from "@/lib/trial-compare";
import { getApiRateUsage, getLaneRateUsage } from "@/lib/rate-limit";
import { getPerReelQuota } from "@/lib/instagram-api";
import { laneStatus } from "@/lib/api-lanes";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const running = getTrialCompareProgress();
  if (running.running) {
    return NextResponse.json(
      { error: "A comparison is already running", progress: running },
      { status: 409 },
    );
  }

  const { reelLines } = (await request.json()) as { reelLines?: string[] };
  if (!reelLines?.length) {
    return NextResponse.json({ error: "Reel URLs required" }, { status: 400 });
  }

  const { jobs, bad } = parseTrialLines(reelLines);
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

  // Fire and forget — the UI polls GET, the same way every other checker works.
  runTrialCompare(jobs);

  return NextResponse.json({
    message: `Started on ${jobs.length} trial reel${jobs.length === 1 ? "" : "s"}`,
    // Named rather than dropped: a silently skipped line is a reel the user
    // believes was measured.
    skippedLines: bad,
    progress: getTrialCompareProgress(),
  });
}

export async function GET() {
  return NextResponse.json(
    {
      ...getTrialCompareProgress(),
      rate: getApiRateUsage(),
      // The per-reel plan is the one this section can actually exhaust: one
      // call per trial reel, 75,000 a month. A budget nobody can see is a
      // budget nobody notices until it is gone.
      perReel: getPerReelQuota(),
      lane: { ...getLaneRateUsage("views"), ...laneStatus("views") },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function DELETE() {
  stopTrialCompare();
  return NextResponse.json({ message: "Stopped" });
}
