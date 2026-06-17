"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Globe, Users, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface LoginRow {
  user: string;
  ip: string;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  lastPath: string;
  userAgent: string;
}

interface LoginsResponse {
  logins: LoginRow[];
  totalRequests: number;
  uniqueIps?: number;
  note?: string;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

function shortUa(ua: string): string {
  if (!ua) return "—";
  const m = ua.match(/(Chrome|Firefox|Safari|Edg|OPR|curl|Mobile)[\/ ]?([\d.]+)?/i);
  const os = ua.match(/(Windows NT [\d.]+|Mac OS X [\d_]+|Android [\d.]+|iPhone|Linux)/i);
  const browser = m ? m[1] : "?";
  return os ? `${browser} · ${os[1]}` : browser;
}

export function SecurityPage() {
  const [data, setData] = useState<LoginsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/security/logins", { cache: "no-store" });
      const json: LoginsResponse = await res.json();
      setData(json);
    } catch {
      setData({ logins: [], totalRequests: 0, note: "Failed to load." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const logins = data?.logins ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Dashboard Logins</h1>
          <p className="text-sm text-muted-foreground mt-1">
            IP addresses that have signed in to this dashboard, with the username
            used, how many requests, and when.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-1.5 size-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Globe className="size-4" /> Unique IPs
          </div>
          <div className="text-2xl font-bold mt-1">{data?.uniqueIps ?? logins.length}</div>
        </div>
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Users className="size-4" /> Usernames
          </div>
          <div className="text-2xl font-bold mt-1">
            {new Set(logins.map((l) => l.user)).size}
          </div>
        </div>
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Activity className="size-4" /> Authenticated requests
          </div>
          <div className="text-2xl font-bold mt-1">{data?.totalRequests ?? 0}</div>
        </div>
      </div>

      {data?.note && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
          {data.note}
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 pl-4">#</TableHead>
              <TableHead>IP address</TableHead>
              <TableHead>Username</TableHead>
              <TableHead className="w-20">Requests</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>First seen</TableHead>
              <TableHead>Device</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logins.map((row, idx) => (
              <TableRow key={`${row.user}-${row.ip}`}>
                <TableCell className="pl-4 text-muted-foreground text-xs">{idx + 1}</TableCell>
                <TableCell className="font-mono text-sm">{row.ip}</TableCell>
                <TableCell className="font-medium">{row.user}</TableCell>
                <TableCell className="text-muted-foreground">{row.count}</TableCell>
                <TableCell className="text-sm">{fmt(row.lastSeen)}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{fmt(row.firstSeen)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{shortUa(row.userAgent)}</TableCell>
              </TableRow>
            ))}
            {logins.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  {loading ? "Loading…" : "No dashboard logins recorded yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
