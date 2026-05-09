import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Get all schedule entries and join with tracked accounts data
    const entries = await prisma.scheduleEntry.findMany();
    
    // Get all tracked accounts (for stats)
    const usernames = entries.map((e) => e.username);
    const accounts = await prisma.trackedAccount.findMany({
      where: { username: { in: usernames } },
      include: {
        media: {
          include: {
            snapshots: {
              orderBy: { snapshotAt: "desc" },
              take: 1,
            },
          },
        },
      },
    });

    const accountMap = new Map(accounts.map((a) => [a.username, a]));

    const result = entries.map((entry) => {
      const account = accountMap.get(entry.username);
      
      let avgLast36Views = 0;
      let videosTracked = 0;
      let status = "active";
      let isTracked = false;
      
      if (account) {
        isTracked = true;
        status = account.status ?? "active";
        videosTracked = account.media.length;
        
        const sortedByRecency = [...account.media].sort((a, b) => {
          const at = a.publishedAt?.getTime() ?? 0;
          const bt = b.publishedAt?.getTime() ?? 0;
          if (at !== bt) return bt - at;
          return b.igMediaId.localeCompare(a.igMediaId);
        });
        
        let last36Views = 0;
        let last36Count = 0;
        for (const m of sortedByRecency.slice(0, 36)) {
          const snap = m.snapshots[0];
          if (snap) {
            last36Views += snap.viewCount;
            last36Count++;
          }
        }
        avgLast36Views = last36Count > 0 ? Math.round(last36Views / last36Count) : 0;
      }

      // Calculate days remaining
      let daysRemaining: number | null = null;
      let urgencyStatus = "no_date";
      
      if (entry.expiryDate) {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const expiry = new Date(entry.expiryDate);
        const expiryDay = new Date(expiry.getFullYear(), expiry.getMonth(), expiry.getDate());
        daysRemaining = Math.round((expiryDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        
        if (daysRemaining < 0) urgencyStatus = "expired";
        else if (daysRemaining === 0) urgencyStatus = "today";
        else if (daysRemaining <= 3) urgencyStatus = "urgent";
        else if (daysRemaining <= 7) urgencyStatus = "soon";
        else urgencyStatus = "ok";
      }

      return {
        id: entry.id,
        username: entry.username,
        category: entry.category,
        expiryDate: entry.expiryDate,
        note: entry.note,
        daysRemaining,
        urgencyStatus,
        isTracked,
        status,
        videosTracked,
        avgLast36Views,
      };
    });

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Scheduler GET error:", error);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { username, category, expiryDate, note } = body;
    
    if (!username || !category) {
      return NextResponse.json({ error: "Missing username or category" }, { status: 400 });
    }
    
    const cleanUsername = String(username).trim().toLowerCase().replace(/^@/, "");
    if (!cleanUsername) {
      return NextResponse.json({ error: "Invalid username" }, { status: 400 });
    }
    
    const upperCategory = String(category).toUpperCase();
    if (!["ODLIČAN", "DOBAR", "SREDNJI"].includes(upperCategory)) {
      return NextResponse.json({ error: "Invalid category" }, { status: 400 });
    }
    
    const entry = await prisma.scheduleEntry.upsert({
      where: { username: cleanUsername },
      update: {
        category: upperCategory,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        note: note || null,
      },
      create: {
        username: cleanUsername,
        category: upperCategory,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        note: note || null,
      },
    });
    
    return NextResponse.json(entry);
  } catch (error) {
    console.error("Scheduler POST error:", error);
    return NextResponse.json({ error: "Failed to create" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, expiryDate, category, note } = body;
    
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }
    
    const updateData: { expiryDate?: Date | null; category?: string; note?: string | null } = {};
    if (expiryDate !== undefined) {
      updateData.expiryDate = expiryDate ? new Date(expiryDate) : null;
    }
    if (category !== undefined) updateData.category = category;
    if (note !== undefined) updateData.note = note;
    
    const updated = await prisma.scheduleEntry.update({
      where: { id },
      data: updateData,
    });
    
    return NextResponse.json(updated);
  } catch (error) {
    console.error("Scheduler PATCH error:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }
    
    await prisma.scheduleEntry.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Scheduler DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}
