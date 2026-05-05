import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { AccountDetailClient } from "@/components/account/account-detail-client";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AccountPage({ params }: PageProps) {
  const { id } = await params;

  const account = await prisma.trackedAccount.findUnique({
    where: { id },
    include: {
      snapshots: {
        orderBy: { snapshotAt: "desc" },
        take: 90,
      },
      media: {
        include: {
          snapshots: {
            orderBy: { snapshotAt: "desc" },
            take: 1,
          },
        },
        orderBy: { publishedAt: "desc" },
      },
    },
  });

  if (!account) {
    notFound();
  }

  const serialized = {
    ...account,
    lastRefreshedAt: account.lastRefreshedAt?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
    snapshots: account.snapshots.map((s) => ({
      ...s,
      snapshotAt: s.snapshotAt.toISOString(),
    })),
    media: account.media.map((m) => ({
      ...m,
      publishedAt: m.publishedAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
      snapshots: m.snapshots.map((ms) => ({
        ...ms,
        snapshotAt: ms.snapshotAt.toISOString(),
      })),
    })),
  };

  return <AccountDetailClient account={serialized} />;
}
