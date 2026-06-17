import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { ENABLE_SECURITY } from "@/lib/modules";

export const dynamic = "force-dynamic";

// Dedicated access log for THIS site (configured in its nginx server block).
// Override with SECURITY_ACCESS_LOG if needed.
const LOG_PATH = process.env.SECURITY_ACCESS_LOG || "/var/log/nginx/tracker.access.log";

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// nginx "combined": IP - user [time] "request" status bytes "ref" "ua"
const LINE = /^(\S+) \S+ (\S+) \[([^\]]+)\] "([^"]*)" (\d{3}) \d+ "[^"]*" "([^"]*)"/;

function parseClfDate(s: string): number {
  const m = s.match(/^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!m) return 0;
  const [, dd, mon, yyyy, hh, mi, ss, sign, oh, om] = m;
  let t = Date.UTC(+yyyy, MONTHS[mon] ?? 0, +dd, +hh, +mi, +ss);
  const offset = (+oh * 60 + +om) * (sign === "-" ? -1 : 1) * 60_000;
  t -= offset; // convert local-with-offset to real UTC
  return t;
}

interface Entry {
  user: string;
  ip: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  lastPath: string;
  userAgent: string;
}

export async function GET() {
  if (!ENABLE_SECURITY) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const files = [LOG_PATH, `${LOG_PATH}.1`].filter((f) => existsSync(f));
  if (files.length === 0) {
    return NextResponse.json({
      logins: [],
      totalRequests: 0,
      note: `No access log yet at ${LOG_PATH}. It starts collecting once nginx writes to it.`,
    });
  }

  const byKey = new Map<string, Entry>();
  let totalRequests = 0;

  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    // cap to the most recent ~150k lines for safety
    const start = Math.max(0, lines.length - 150_000);
    for (let i = start; i < lines.length; i++) {
      const m = lines[i].match(LINE);
      if (!m) continue;
      const [, ip, user, time, request, , ua] = m;
      // only authenticated dashboard hits (basic-auth username present)
      if (!user || user === "-") continue;
      totalRequests++;
      const ts = parseClfDate(time);
      const path = (request.split(" ")[1] || request).split("?")[0];
      const key = `${user}\u0000${ip}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count++;
        if (ts > existing.lastSeen) {
          existing.lastSeen = ts;
          existing.lastPath = path;
          existing.userAgent = ua;
        }
        if (ts < existing.firstSeen) existing.firstSeen = ts;
      } else {
        byKey.set(key, {
          user,
          ip,
          count: 1,
          firstSeen: ts,
          lastSeen: ts,
          lastPath: path,
          userAgent: ua,
        });
      }
    }
  }

  const logins = Array.from(byKey.values())
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((e) => ({
      user: e.user,
      ip: e.ip,
      count: e.count,
      firstSeen: e.firstSeen ? new Date(e.firstSeen).toISOString() : null,
      lastSeen: e.lastSeen ? new Date(e.lastSeen).toISOString() : null,
      lastPath: e.lastPath,
      userAgent: e.userAgent,
    }));

  return NextResponse.json(
    { logins, totalRequests, uniqueIps: logins.length },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
