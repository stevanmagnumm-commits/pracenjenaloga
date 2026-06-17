"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Film, Users, Plus, Instagram, AtSign, Music, Ghost, ShieldAlert, ShieldCheck, Calendar, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ENABLE_THREADS, ENABLE_TIKTOK, ENABLE_SNAPCHAT, ENABLE_SECURITY } from "@/lib/modules";

const igNavItems = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/videos", label: "All Videos", icon: Film },
  { href: "/accounts", label: "All Accounts", icon: Users },
  { href: "/creators", label: "Creators", icon: UserPlus },
  { href: "/scheduler", label: "Scheduler", icon: Calendar },
  { href: "/ig-ban-checker", label: "Ban Checker", icon: ShieldAlert },
  ...(ENABLE_SECURITY
    ? [{ href: "/security", label: "Login Monitor", icon: ShieldCheck }]
    : []),
];

const threadsNavItems = [
  { href: "/threads", label: "Overview", icon: LayoutDashboard },
  { href: "/threads/accounts", label: "All Accounts", icon: Users },
];

const tiktokNavItems = [
  { href: "/tiktok", label: "Top Videos", icon: Film },
];

const snapchatNavItems = [
  { href: "/snapchat", label: "Account Status", icon: Users },
];

interface SidebarProps {
  onTrackAccount: () => void;
}

type Platform = "instagram" | "threads" | "tiktok" | "snapchat";

export function Sidebar({ onTrackAccount }: SidebarProps) {
  const pathname = usePathname();
  const platform: Platform = pathname.startsWith("/snapchat")
    ? "snapchat"
    : pathname.startsWith("/tiktok")
      ? "tiktok"
      : pathname.startsWith("/threads")
        ? "threads"
        : "instagram";
  const navItems =
    platform === "snapchat"
      ? snapchatNavItems
      : platform === "tiktok"
        ? tiktokNavItems
        : platform === "threads"
          ? threadsNavItems
          : igNavItems;

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-56 flex-col border-r border-border bg-card">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary">
          <Film className="size-4 text-primary-foreground" />
        </div>
        <span className="text-lg font-bold">Tracker</span>
      </div>

      <div className="grid grid-cols-2 gap-1 border-b border-border p-2">
        <Link
          href="/"
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
            platform === "instagram"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          <Instagram className="size-3.5" />
          Instagram
        </Link>
        {ENABLE_THREADS && (
          <Link
            href="/threads"
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
              platform === "threads"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <AtSign className="size-3.5" />
            Threads
          </Link>
        )}
        {ENABLE_TIKTOK && (
          <Link
            href="/tiktok"
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
              platform === "tiktok"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <Music className="size-3.5" />
            TikTok
          </Link>
        )}
        {ENABLE_SNAPCHAT && (
          <Link
            href="/snapchat"
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
              platform === "snapchat"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <Ghost className="size-3.5" />
            Snapchat
          </Link>
        )}
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {navItems.map((item) => {
          const isActive =
            platform === "snapchat"
              ? pathname.startsWith(item.href)
              : platform === "tiktok"
                ? pathname.startsWith(item.href)
                : platform === "threads"
                  ? item.href === "/threads"
                    ? pathname === "/threads"
                    : pathname.startsWith(item.href) && item.href !== "/threads"
                  : item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={item.href === "/security" ? false : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {platform !== "tiktok" && platform !== "snapchat" && (
        <div className="border-t border-border p-3">
          <button
            onClick={onTrackAccount}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="size-4" />
            Track Accounts
          </button>
        </div>
      )}
    </aside>
  );
}
