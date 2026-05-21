import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/creators/accounts?creatorId=XYZ
 * Returns all accounts under a given creator, joined with whether each
 * username is already in the tracker + scheduler.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const creatorId = searchParams.get("creatorId");

  const where = creatorId ? { creatorId } : {};
  const accounts = await prisma.creatorAccount.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });

  // Annotate with inTracker / inScheduler so the UI can show badges
  const usernames = accounts.map((a) => a.username);
  const [tracked, scheduled] = await Promise.all([
    prisma.trackedAccount.findMany({
      where: { username: { in: usernames } },
      select: { username: true, status: true, lastRefreshedAt: true },
    }),
    prisma.scheduleEntry.findMany({
      where: { username: { in: usernames } },
      select: { username: true, expiryDate: true, category: true },
    }),
  ]);
  const trackedMap = new Map(tracked.map((t) => [t.username, t]));
  const schedMap = new Map(scheduled.map((s) => [s.username, s]));

  const enriched = accounts.map((a) => {
    const isDraft = a.username.startsWith("__draft_");
    const isSeparator = a.kind === "separator";
    const t = isDraft || isSeparator ? undefined : trackedMap.get(a.username);
    const s = isDraft || isSeparator ? undefined : schedMap.get(a.username);
    return {
      ...a,
      // Hide internal placeholder username from the UI; the user sees an
      // empty cell until they type a real username over it.
      username: isDraft || isSeparator ? "" : a.username,
      _rawUsername: a.username,
      inTracker: !!t,
      trackerStatus: t?.status ?? null,
      lastRefreshedAt: t?.lastRefreshedAt ?? null,
      inScheduler: !!s,
      scheduleCategory: s?.category ?? null,
      scheduleExpiryDate: s?.expiryDate ?? null,
    };
  });

  return NextResponse.json(enriched);
}

/**
 * POST /api/creators/accounts
 * Single create: { creatorId, username, password?, twoFa?, proxy?, notes?, snapAccount? }
 * Bulk create:   { creatorId, accounts: [{ username, ... }, ...] }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { creatorId, accounts: bulkRows } = body as {
    creatorId: string;
    accounts?: Array<{
      username: string;
      password?: string;
      twoFa?: string;
      proxy?: string;
      notes?: string;
      snapAccount?: string;
    }>;
  };

  if (!creatorId) {
    return NextResponse.json({ error: "creatorId is required" }, { status: 400 });
  }

  if (bulkRows && Array.isArray(bulkRows) && bulkRows.length > 0) {
    const created: typeof bulkRows = [];
    const skipped: string[] = [];
    for (const row of bulkRows) {
      // Allow truly blank rows by generating a __draft_ placeholder username.
      // The UI hides these and lets the user overwrite via inline edit.
      const rawUsername = (row.username || "").trim();
      const username = rawUsername || `__draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      try {
        const c = await prisma.creatorAccount.create({
          data: {
            creatorId,
            username,
            password: row.password || null,
            twoFa: row.twoFa || null,
            proxy: row.proxy || null,
            notes: row.notes || null,
            snapAccount: row.snapAccount || null,
            scheduledBy: (row as { scheduledBy?: string }).scheduledBy || null,
            expiryDate: parseDateInput((row as { expiryDate?: string }).expiryDate),
          },
        });
        created.push(c as never);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("Unique constraint")) {
          skipped.push(username);
        } else {
          console.error(`[creators/accounts] failed to create @${username}:`, e);
        }
      }
    }
    return NextResponse.json({
      created: created.length,
      skipped: skipped.length,
      skippedUsernames: skipped,
    }, { status: 201 });
  }

  const { kind, username, password, twoFa, proxy, notes, snapAccount, scheduledBy, expiryDate } = body as {
    kind?: "account" | "separator";
    username?: string;
    password?: string;
    twoFa?: string;
    proxy?: string;
    notes?: string;
    snapAccount?: string;
    scheduledBy?: string;
    expiryDate?: string;
  };

  // Separator rows are visual "new day" dividers — they need a hidden
  // placeholder username (unique) but otherwise just carry a date + label.
  if (kind === "separator") {
    const placeholder = `__separator_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const created = await prisma.creatorAccount.create({
      data: {
        creatorId,
        kind: "separator",
        username: placeholder,
        notes: notes || null,
        expiryDate: parseDateInput(expiryDate) || new Date(),
      },
    });
    return NextResponse.json(created, { status: 201 });
  }

  if (!username || !username.trim()) {
    return NextResponse.json({ error: "username is required" }, { status: 400 });
  }

  try {
    const created = await prisma.creatorAccount.create({
      data: {
        creatorId,
        username: username.trim(),
        password: password || null,
        twoFa: twoFa || null,
        proxy: proxy || null,
        notes: notes || null,
        snapAccount: snapAccount || null,
        scheduledBy: scheduledBy || null,
        expiryDate: parseDateInput(expiryDate),
      },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create";
    if (msg.includes("Unique constraint")) {
      return NextResponse.json({ error: "Username already exists in Creators" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * Parse loosely-formatted user date input. Supports:
 *   ISO        2026-06-01
 *   DD.MM.YY   01.06.26
 *   DD.MM.YYYY 01.06.2026
 *   DD/MM/YY   01/06/26
 *   DD/MM/YYYY 01/06/2026
 * Returns null for empty / unparseable.
 */
function parseDateInput(input: string | null | undefined): Date | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // ISO YYYY-MM-DD (native date input default)
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  const eu = trimmed.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (eu) {
    const day = +eu[1];
    const month = +eu[2];
    let year = +eu[3];
    if (year < 100) year += 2000;
    return new Date(Date.UTC(year, month - 1, day));
  }
  const parsed = new Date(trimmed);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * PATCH /api/creators/accounts?id=ABC
 * Update any subset of fields. Useful for inline cell editing.
 */
export async function PATCH(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const body = await request.json();
  const {
    username,
    password,
    twoFa,
    proxy,
    notes,
    snapAccount,
    scheduledBy,
    scheduledAt,
    postsLeft,
    expiryDate,
    creatorId,
  } = body as {
    username?: string;
    password?: string | null;
    twoFa?: string | null;
    proxy?: string | null;
    notes?: string | null;
    snapAccount?: string | null;
    scheduledBy?: string | null;
    scheduledAt?: string | null;
    postsLeft?: number | null;
    expiryDate?: string | null;
    creatorId?: string;
  };

  try {
    const updated = await prisma.creatorAccount.update({
      where: { id },
      data: {
        ...(username !== undefined && { username: username.trim() }),
        ...(password !== undefined && { password: password || null }),
        ...(twoFa !== undefined && { twoFa: twoFa || null }),
        ...(proxy !== undefined && { proxy: proxy || null }),
        ...(notes !== undefined && { notes: notes || null }),
        ...(snapAccount !== undefined && { snapAccount: snapAccount || null }),
        ...(scheduledBy !== undefined && { scheduledBy: scheduledBy || null }),
        ...(scheduledAt !== undefined && {
          scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        }),
        ...(postsLeft !== undefined && {
          postsLeft: postsLeft === null ? null : Number(postsLeft),
        }),
        ...(expiryDate !== undefined && {
          expiryDate: parseDateInput(expiryDate),
        }),
        ...(creatorId !== undefined && { creatorId }),
      },
    });
    return NextResponse.json(updated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Update failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * DELETE /api/creators/accounts?id=ABC  → single
 * DELETE /api/creators/accounts (body: { ids: [] })  → bulk
 */
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (id) {
    await prisma.creatorAccount.delete({ where: { id } });
    return NextResponse.json({ success: true });
  }
  const body = await request.json().catch(() => ({}));
  const { ids } = body as { ids?: string[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "Provide ?id=... or { ids: [...] }" }, { status: 400 });
  }
  const result = await prisma.creatorAccount.deleteMany({
    where: { id: { in: ids } },
  });
  return NextResponse.json({ success: true, deleted: result.count });
}
