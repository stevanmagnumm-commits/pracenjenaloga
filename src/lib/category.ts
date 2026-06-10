// Single source of truth for the performance categories used across the app
// (scheduler recategorization + the All Accounts page). A category is derived
// purely from the rolling average of an account's last 36 reel views.

export type Category = "ODLIČAN" | "DOBAR" | "LOŠI" | "SHADOWBANNED";

export const CATEGORY_THRESHOLDS: Array<{ min: number; category: Category }> = [
  { min: 800, category: "ODLIČAN" },
  { min: 200, category: "DOBAR" },
  { min: 50, category: "LOŠI" },
  { min: 0, category: "SHADOWBANNED" },
];

export function categoryForViews(avgLast36Views: number): Category {
  for (const t of CATEGORY_THRESHOLDS) {
    if (avgLast36Views >= t.min) return t.category;
  }
  return "SHADOWBANNED";
}

// Display order (best → worst) and per-category presentation metadata used by
// the UI (filter tabs + row badges).
export const CATEGORY_ORDER: Category[] = ["ODLIČAN", "DOBAR", "LOŠI", "SHADOWBANNED"];

export const CATEGORY_META: Record<
  Category,
  { label: string; emoji: string; badgeCls: string; activeCls: string }
> = {
  "ODLIČAN": {
    label: "ODLIČAN",
    emoji: "⭐",
    badgeCls: "bg-green-500/15 text-green-400",
    activeCls: "bg-green-500/20 text-green-400",
  },
  "DOBAR": {
    label: "DOBAR",
    emoji: "✅",
    badgeCls: "bg-blue-500/15 text-blue-400",
    activeCls: "bg-blue-500/20 text-blue-400",
  },
  "LOŠI": {
    label: "LOŠI",
    emoji: "⚠️",
    badgeCls: "bg-orange-500/15 text-orange-400",
    activeCls: "bg-orange-500/20 text-orange-400",
  },
  "SHADOWBANNED": {
    label: "SB",
    emoji: "🌑",
    badgeCls: "bg-zinc-500/20 text-zinc-300",
    activeCls: "bg-zinc-500/30 text-zinc-200",
  },
};
