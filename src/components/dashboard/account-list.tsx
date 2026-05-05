"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Search, SlidersHorizontal, Inbox } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AccountCard, type TrackedAccount } from "./account-card";

type SortKey = "priority" | "followers" | "media" | "dateAdded";

interface AccountListProps {
  refreshKey: number;
}

export function AccountList({ refreshKey }: AccountListProps) {
  const [accounts, setAccounts] = useState<TrackedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("priority");

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts");
      if (res.ok) setAccounts(await res.json());
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts, refreshKey]);

  function handleDelete(id: string) {
    setAccounts((prev) => prev.filter((a) => a.id !== id));
  }

  const filtered = useMemo(() => {
    let result = accounts;

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.username.toLowerCase().includes(q) ||
          (a.fullName?.toLowerCase().includes(q) ?? false)
      );
    }

    result = [...result].sort((a, b) => {
      const snapA = a.snapshots[0];
      const snapB = b.snapshots[0];

      switch (sortBy) {
        case "followers":
          return (snapB?.followerCount ?? 0) - (snapA?.followerCount ?? 0);
        case "media":
          return (snapB?.mediaCount ?? 0) - (snapA?.mediaCount ?? 0);
        case "dateAdded":
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case "priority":
        default:
          if (a.priority !== b.priority) return a.priority - b.priority;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });

    return result;
  }, [accounts, search, sortBy]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search accounts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="size-4 text-muted-foreground" />
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="priority">Priority</SelectItem>
              <SelectItem value="followers">Followers</SelectItem>
              <SelectItem value="media">Media Count</SelectItem>
              <SelectItem value="dateAdded">Date Added</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-muted-foreground">
          <Inbox className="size-10" />
          <div className="text-center">
            <p className="font-medium">
              {accounts.length === 0
                ? "No accounts tracked yet"
                : "No accounts match your search"}
            </p>
            <p className="text-sm">
              {accounts.length === 0
                ? "Click \"Track Account\" to get started."
                : "Try adjusting your search term."}
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
