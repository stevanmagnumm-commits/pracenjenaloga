import { NextResponse } from "next/server";
import { getApiUsage } from "@/lib/instagram-api";

export const dynamic = "force-dynamic";

export async function GET() {
  const usage = await getApiUsage();
  return NextResponse.json(usage);
}
