"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { TrackAccountDialog } from "@/components/dashboard/track-account-dialog";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [trackDialogOpen, setTrackDialogOpen] = useState(false);
  const pathname = usePathname();
  const platform = pathname.startsWith("/snapchat")
    ? "snapchat"
    : pathname.startsWith("/tiktok")
      ? "tiktok"
      : pathname.startsWith("/threads")
        ? "threads"
        : "instagram";

  // Standalone routes that should NOT show the admin sidebar — meant to be
  // shared with external collaborators (e.g. a creator's personal sheet URL).
  const isStandalone = /^\/creators\/[^/]+$/.test(pathname);
  if (isStandalone) {
    return <main className="min-h-screen">{children}</main>;
  }

  return (
    <>
      <Sidebar onTrackAccount={() => setTrackDialogOpen(true)} />
      <main className="ml-56 min-h-screen">{children}</main>
      <TrackAccountDialog
        open={trackDialogOpen}
        onOpenChange={setTrackDialogOpen}
        onSuccess={() => setTrackDialogOpen(false)}
        platform={platform}
      />
    </>
  );
}
