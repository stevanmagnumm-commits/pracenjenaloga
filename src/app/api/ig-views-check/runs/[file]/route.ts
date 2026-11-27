import { NextRequest, NextResponse } from "next/server";
import { readArchivedRun } from "@/lib/views-run-archive";

export const dynamic = "force-dynamic";

/** Download one saved run. The name is checked against a strict pattern, so
 *  nothing outside the runs folder can be asked for. */
export async function GET(_request: NextRequest, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  const buf = await readArchivedRun(file);
  if (!buf) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${file}"`,
      "Cache-Control": "no-store",
    },
  });
}
