import { NextRequest, NextResponse } from "next/server";
import { runIgBanCheck, getIgBanCheckProgress, stopIgBanCheck } from "@/lib/ig-ban-check";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const progress = getIgBanCheckProgress();
  if (progress.running) {
    return NextResponse.json(
      { error: "Check already in progress", progress },
      { status: 409 }
    );
  }

  const { usernames } = (await request.json()) as { usernames: string[] };

  if (!usernames?.length) {
    return NextResponse.json({ error: "Usernames required" }, { status: 400 });
  }

  runIgBanCheck(usernames);

  return NextResponse.json({
    message: `Started checking ${usernames.length} accounts`,
    progress: getIgBanCheckProgress(),
  });
}

export async function GET() {
  return NextResponse.json(getIgBanCheckProgress(), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function DELETE() {
  stopIgBanCheck();
  return NextResponse.json({ message: "Check stopped" });
}
