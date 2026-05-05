import { NextRequest, NextResponse } from "next/server";
import { getAccountInsights, getGrowthRate } from "@/lib/insights";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const { accountId } = await params;
  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get("days") || "30", 10);

  const [insights, growth] = await Promise.all([
    getAccountInsights(accountId),
    getGrowthRate(accountId, days),
  ]);

  return NextResponse.json({ insights, growth });
}
