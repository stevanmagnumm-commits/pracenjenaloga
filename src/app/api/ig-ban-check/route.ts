import { NextRequest, NextResponse } from "next/server";
import {
  runIgBanCheck,
  getIgBanCheckProgress,
  stopIgBanCheck,
  getResumableBanCheck,
  resumeIgBanCheck,
} from "@/lib/ig-ban-check";
import { getApiRateUsage } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const progress = getIgBanCheckProgress();
  if (progress.running) {
    return NextResponse.json(
      { error: "Check already in progress", progress },
      { status: 409 }
    );
  }

  const { usernames, resume } = (await request.json()) as {
    usernames?: string[];
    resume?: boolean;
  };

  // Continue a list a restart cut off, without re-checking anyone.
  if (resume) {
    const started = await resumeIgBanCheck();
    if (!started) {
      return NextResponse.json({ error: "Nothing to resume" }, { status: 409 });
    }
    return NextResponse.json({ message: "Resumed", progress: getIgBanCheckProgress() });
  }

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
  return NextResponse.json(
    {
      ...getIgBanCheckProgress(),
      resumable: await getResumableBanCheck(),
      rate: getApiRateUsage(),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function DELETE() {
  stopIgBanCheck();
  return NextResponse.json({ message: "Check stopped" });
}
