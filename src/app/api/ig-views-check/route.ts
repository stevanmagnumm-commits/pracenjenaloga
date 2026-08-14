import { NextRequest, NextResponse } from "next/server";
import {
  runIgViewsCheck,
  getIgViewsCheckProgress,
  stopIgViewsCheck,
} from "@/lib/ig-views-check";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const progress = getIgViewsCheckProgress();
  if (progress.running) {
    return NextResponse.json(
      { error: "Check already in progress", progress },
      { status: 409 },
    );
  }

  const { usernames } = (await request.json()) as { usernames: string[] };

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
  return NextResponse.json(getIgViewsCheckProgress(), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function DELETE() {
  stopIgViewsCheck();
  return NextResponse.json({ message: "Check stopped" });
}
