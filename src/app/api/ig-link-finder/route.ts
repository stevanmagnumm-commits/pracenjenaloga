import { NextRequest, NextResponse } from "next/server";
import {
  runLinkFinder,
  getLinkFinderProgress,
  stopLinkFinder,
} from "@/lib/ig-link-finder";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const progress = getLinkFinderProgress();
  if (progress.running) {
    return NextResponse.json({ error: "Search already in progress", progress }, { status: 409 });
  }

  const { seeds, checkHighlights, maxCandidates } = (await request.json()) as {
    seeds: string[];
    checkHighlights?: boolean;
    maxCandidates?: number;
  };

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
  return NextResponse.json(getLinkFinderProgress(), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function DELETE() {
  stopLinkFinder();
  return NextResponse.json({ message: "Search stopped" });
}
