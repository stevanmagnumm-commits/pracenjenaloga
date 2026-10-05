import { NextRequest, NextResponse } from "next/server";
import {
  runAccountCheck,
  getAccountCheckProgress,
  stopAccountCheck,
} from "@/lib/ig-account-check";
import { getApiRateUsage, getLaneRateUsage } from "@/lib/rate-limit";
import { laneStatus } from "@/lib/api-lanes";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const progress = getAccountCheckProgress();
  if (progress.running) {
    return NextResponse.json(
      { error: "Check already in progress", progress },
      { status: 409 },
    );
  }

  const { usernames, wants } = (await request.json()) as {
    usernames?: string[];
    wants?: { highlights?: boolean; posts?: boolean; lastPost?: boolean };
  };

  if (!usernames?.length) {
    return NextResponse.json({ error: "Usernames required" }, { status: 400 });
  }

  const w = {
    highlights: !!wants?.highlights,
    posts: !!wants?.posts,
    lastPost: !!wants?.lastPost,
  };
  if (!w.highlights && !w.posts && !w.lastPost) {
    return NextResponse.json(
      { error: "Tick at least one thing to check" },
      { status: 400 },
    );
  }

  // Fire and forget — the UI polls GET, same as the other checkers.
  runAccountCheck(usernames, w);

  return NextResponse.json({
    message: "Started on " + usernames.length + " accounts",
    progress: getAccountCheckProgress(),
  });
}

export async function GET(request: NextRequest) {
  const p = getAccountCheckProgress();
  // Rows only when asked for: the poll runs every 1.5s and must stay small.
  const wantResults = request.nextUrl.searchParams.get("results") === "1";
  const { results, ...rest } = p;
  return NextResponse.json(
    {
      ...rest,
      results: wantResults ? results : [],
      resultCount: results.length,
      rate: getApiRateUsage(),
      // A trickle has to be visible, or it reads as a freeze.
      lane: { ...getLaneRateUsage("account"), ...laneStatus("account") },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function DELETE() {
  stopAccountCheck();
  return NextResponse.json({ message: "Stopped" });
}
