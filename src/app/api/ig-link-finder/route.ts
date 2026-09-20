import { NextRequest, NextResponse } from "next/server";
import {
  runLinkFinder,
  getLinkFinderProgress,
  stopLinkFinder,
  getResumableRun,
  resumeLinkFinder,
} from "@/lib/ig-link-finder";
import { getApiRateUsage } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const progress = getLinkFinderProgress();
  if (progress.running) {
    return NextResponse.json({ error: "Search already in progress", progress }, { status: 409 });
  }

  const { seeds, checkHighlights, maxCandidates, resume } = (await request.json()) as {
    seeds?: string[];
    checkHighlights?: boolean;
    maxCandidates?: number;
    resume?: boolean;
  };

  // Continue an interrupted run: the work list comes off disk, the suggestions
  // are not fetched again, and the accounts already answered for are not paid
  // for twice.
  if (resume) {
    const started = await resumeLinkFinder();
    if (!started) {
      return NextResponse.json({ error: "Nothing to resume" }, { status: 409 });
    }
    return NextResponse.json({
      message: "Resumed",
      progress: getLinkFinderProgress(),
    });
  }

  if (!seeds?.length) {
    return NextResponse.json({ error: "Seed accounts required" }, { status: 400 });
  }

  // Fire and forget — the UI polls GET for progress, same as the other checkers.
  runLinkFinder(seeds, { checkHighlights, maxCandidates });

  return NextResponse.json({
    message: `Started from ${seeds.length} seed account(s)`,
    progress: getLinkFinderProgress(),
  });
}

export async function GET() {
  const progress = getLinkFinderProgress();
  return NextResponse.json(
    {
      ...progress,
      // Only meaningful while idle; the UI uses it to offer a resume.
      resumable: await getResumableRun(),
      rate: getApiRateUsage(),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function DELETE() {
  stopLinkFinder();
  return NextResponse.json({ message: "Search stopped" });
}
