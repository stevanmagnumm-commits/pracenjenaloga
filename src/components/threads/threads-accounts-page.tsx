"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpDown, Trash2, TrendingUp, TrendingDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber } from "@/lib/utils";

interface ThreadsStat {
  id: string;
  username: string;
  fullName: string | null;
  isVerified: boolean;
  followers: number;
  growth7d: number;
  growth30d: number;
  growthPct7d: number;
  growthPct30d: number;
  lastTracked: string | null;
}

type SortField =
  | "followers"
  | "growth7d"
  | "growth30d"
  | "growthPct7d"
  | "growthPct30d"
  | "lastTracked";

type SortDir = "asc" | "desc";

export function ThreadsAccountsPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<ThreadsStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortField>("followers");
  const [dir, setDir] = useState<SortDir>("desc");

  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort, dir });
      const res = await fetch(`/api/threads/accounts/stats?${params}`);
      if (res.ok) {
        setAccounts(await res.json());
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, [sort, dir]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  async function handleDelete(e: React.MouseEvent, accountId: string, username: string) {
    e.stopPropagation();
    if (!confirm(`Delete @${username} and all its data?`)) return;
    try {
      const res = await fetch(`/api/threads/accounts?id=${accountId}`, { method: "DELETE" });
      if (res.ok) {
        setAccounts((prev) => prev.filter((a) => a.id !== accountId));
      }
    } catch {}
  }

  function handleSort(field: SortField) {
    if (sort === field) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setDir("desc");
    }
  }

  function SortableHeader({
    field,
    children,
    className,
  }: {
    field: SortField;
    children: React.ReactNode;
    className?: string;
  }) {
    return (
      <TableHead className={className}>
        <button
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          onClick={() => handleSort(field)}
        >
          {children}
          <ArrowUpDown
            className={`size-3 ${sort === field ? "text-primary" : "text-muted-foreground/50"}`}
          />
        </button>
      </TableHead>
    );
  }

  function GrowthCell({ value, pct }: { value: number; pct: number }) {
    if (value === 0) {
      return <span className="text-muted-foreground">-</span>;
    }
    const isPositive = value > 0;
    return (
      <span className={isPositive ? "text-green-400" : "text-red-400"}>
        <span className="inline-flex items-center gap-0.5">
          {isPositive ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
          {isPositive ? "+" : ""}
          {formatNumber(value)}
          <span className="text-xs opacity-70">({pct > 0 ? "+" : ""}{pct}%)</span>
        </span>
      </span>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Threads Accounts</h1>
          <p className="text-sm text-muted-foreground">
            {accounts.length} accounts tracked
          </p>
        </div>
      </div>

      {loading && accounts.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <SortableHeader field="followers" className="text-right">
                  Followers
                </SortableHeader>
                <SortableHeader field="growth7d" className="text-right">
                  7d Growth
                </SortableHeader>
                <SortableHeader field="growth30d" className="text-right">
                  30d Growth
                </SortableHeader>
                <SortableHeader field="lastTracked">Last Tracked</SortableHeader>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No Threads accounts tracked yet
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((account) => (
                  <TableRow
                    key={account.id}
                    className="cursor-pointer hover:bg-accent/50"
                    onClick={() => router.push(`/threads/account/${account.id}`)}
                  >
                    <TableCell>
                      <div>
                        <p className="font-medium">
                          @{account.username}
                          {account.isVerified && (
                            <span className="ml-1 text-primary">✓</span>
                          )}
                        </p>
                        {account.fullName && (
                          <p className="text-xs text-muted-foreground">
                            {account.fullName}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatNumber(account.followers)}
                    </TableCell>
                    <TableCell className="text-right">
                      <GrowthCell value={account.growth7d} pct={account.growthPct7d} />
                    </TableCell>
                    <TableCell className="text-right">
                      <GrowthCell value={account.growth30d} pct={account.growthPct30d} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {account.lastTracked
                        ? new Date(account.lastTracked).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "Never"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        onClick={(e) => handleDelete(e, account.id, account.username)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
