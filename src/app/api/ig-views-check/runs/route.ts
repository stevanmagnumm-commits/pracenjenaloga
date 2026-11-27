import { NextResponse } from "next/server";
import { listArchivedRuns } from "@/lib/views-run-archive";

export const dynamic = "force-dynamic";

/** Every saved Views Checker run, newest first. */
export async function GET() {
  return NextResponse.json({ runs: await listArchivedRuns() });
}
