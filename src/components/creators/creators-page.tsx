"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Plus, Users, Copy, Trash2, ExternalLink, AlertTriangle, Eye, EyeOff, RefreshCcw, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Creator {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  accessUsername: string | null;
  accessPassword: string | null;
  createdAt: string;
  _count: { accounts: number };
}

function randomToken(len: number): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function CreatorsPage() {
  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [revealedPasswordIds, setRevealedPasswordIds] = useState<Set<string>>(new Set());
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Creator | null>(null);

  const fetchCreators = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/creators", { cache: "no-store" });
    if (res.ok) setCreators(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchCreators();
  }, [fetchCreators]);

  async function createCreator() {
    if (!newName.trim()) return;
    const res = await fetch("/api/creators", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || "Failed");
      return;
    }
    setNewName("");
    setShowNew(false);
    await fetchCreators();
  }

  async function deleteCreator(c: Creator) {
    const res = await fetch(`/api/creators?id=${c.id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("Failed to delete");
      return;
    }
    setDeleteTarget(null);
    await fetchCreators();
  }

  function copyShareLink(slug: string) {
    const url = `${window.location.origin}/creators/${slug}`;
    navigator.clipboard.writeText(url);
    setCopiedSlug(slug);
    setTimeout(() => setCopiedSlug(null), 2000);
  }

  function copyToClipboard(value: string, marker: string) {
    navigator.clipboard.writeText(value);
    setCopiedField(marker);
    setTimeout(() => setCopiedField(null), 1500);
  }

  function copyFullLogin(c: Creator) {
    const url = `${window.location.origin}/creators/${c.slug}`;
    const text =
      `Link: ${url}\n` +
      `Username: ${c.accessUsername ?? ""}\n` +
      `Password: ${c.accessPassword ?? ""}`;
    navigator.clipboard.writeText(text);
    setCopiedField(`bundle-${c.id}`);
    setTimeout(() => setCopiedField(null), 1500);
  }

  function togglePasswordReveal(id: string) {
    setRevealedPasswordIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function updateCredential(id: string, field: "accessUsername" | "accessPassword", value: string) {
    setCreators((prev) =>
      prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)),
    );
    await fetch(`/api/creators?id=${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    }).catch(() => {});
  }

  async function regeneratePassword(id: string) {
    const newPw = randomToken(12);
    await updateCredential(id, "accessPassword", newPw);
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Creators</h1>
          <p className="text-sm text-muted-foreground">
            Each creator gets their own private sheet — share the link with them and they manage credentials there.
          </p>
        </div>
        <Button onClick={() => setShowNew(true)}>
          <Plus className="size-4" /> New Creator
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : creators.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <Users className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-3 font-medium">No creators yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Add your first creator (e.g. Chris) and share their personal sheet link.
          </p>
          <Button className="mt-4" onClick={() => setShowNew(true)}>
            <Plus className="size-4" /> Create one
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {creators.map((c) => {
            const shareUrl = typeof window !== "undefined"
              ? `${window.location.origin}/creators/${c.slug}`
              : `/creators/${c.slug}`;
            return (
              <div key={c.id} className="rounded-lg border border-border bg-card p-4 transition-shadow hover:shadow-md">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/creators/${c.slug}`} className="block font-semibold hover:text-primary">
                      {c.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">{c._count.accounts} accounts</p>
                  </div>
                  <button
                    onClick={() => setDeleteTarget(c)}
                    className="text-muted-foreground hover:text-red-500"
                    title="Delete creator"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <Link
                    href={`/creators/${c.slug}`}
                    className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    <ExternalLink className="size-3" /> Open sheet
                  </Link>
                  <button
                    onClick={() => copyShareLink(c.slug)}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                  >
                    <Copy className="size-3" />
                    {copiedSlug === c.slug ? "Copied!" : "Copy link"}
                  </button>
                </div>

                <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground">{shareUrl}</p>

                {/* Shared credentials — the per-creator login for the Filipino */}
                <div className="mt-3 rounded-md border border-border bg-muted/40 p-2.5">
                  <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
                    <span>Shared credentials</span>
                    <button
                      onClick={() => copyFullLogin(c)}
                      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] hover:bg-accent"
                      title="Copy link + credentials as one block"
                    >
                      {copiedField === `bundle-${c.id}` ? <Check className="size-3" /> : <Copy className="size-3" />}
                      Copy all
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="w-16 shrink-0 text-[10px] text-muted-foreground">User</span>
                      <input
                        type="text"
                        value={c.accessUsername ?? ""}
                        onChange={(e) => updateCredential(c.id, "accessUsername", e.target.value)}
                        className="flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-xs"
                      />
                      <button
                        onClick={() => copyToClipboard(c.accessUsername ?? "", `u-${c.id}`)}
                        className="rounded-sm p-1 text-muted-foreground hover:bg-accent"
                        title="Copy username"
                      >
                        {copiedField === `u-${c.id}` ? <Check className="size-3" /> : <Copy className="size-3" />}
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="w-16 shrink-0 text-[10px] text-muted-foreground">Pass</span>
                      <input
                        type={revealedPasswordIds.has(c.id) ? "text" : "password"}
                        value={c.accessPassword ?? ""}
                        onChange={(e) => updateCredential(c.id, "accessPassword", e.target.value)}
                        className="flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-xs"
                      />
                      <button
                        onClick={() => togglePasswordReveal(c.id)}
                        className="rounded-sm p-1 text-muted-foreground hover:bg-accent"
                        title={revealedPasswordIds.has(c.id) ? "Hide" : "Reveal"}
                      >
                        {revealedPasswordIds.has(c.id) ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                      </button>
                      <button
                        onClick={() => copyToClipboard(c.accessPassword ?? "", `p-${c.id}`)}
                        className="rounded-sm p-1 text-muted-foreground hover:bg-accent"
                        title="Copy password"
                      >
                        {copiedField === `p-${c.id}` ? <Check className="size-3" /> : <Copy className="size-3" />}
                      </button>
                      <button
                        onClick={() => regeneratePassword(c.id)}
                        className="rounded-sm p-1 text-muted-foreground hover:bg-accent"
                        title="Regenerate password"
                      >
                        <RefreshCcw className="size-3" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Creator</DialogTitle>
            <DialogDescription>Pick a short name — it becomes the share URL.</DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Chris"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") createCreator();
            }}
          />
          {newName.trim() && (
            <p className="text-xs text-muted-foreground">
              URL will be <code className="rounded bg-muted px-1">/creators/{newName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}</code>
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button onClick={createCreator}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-500" />
              Delete "{deleteTarget?.name}"?
            </DialogTitle>
            <DialogDescription>
              Removes the creator and their {deleteTarget?._count.accounts} credential rows. Tracker / Scheduler entries are NOT affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button onClick={() => deleteTarget && deleteCreator(deleteTarget)} className="bg-red-500 hover:bg-red-600">
              <Trash2 className="size-4" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
