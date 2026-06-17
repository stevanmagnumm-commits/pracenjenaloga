import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { ENABLE_THREADS } from "@/lib/modules";
import { ThreadsAccountDetail } from "@/components/threads/threads-account-detail";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ThreadsAccountPage({ params }: PageProps) {
  if (!ENABLE_THREADS) redirect("/");
  const { id } = await params;

  const account = await prisma.threadsAccount.findUnique({
    where: { id },
  });

  if (!account) {
    notFound();
  }

  return (
    <ThreadsAccountDetail
      account={{
        ...account,
        lastRefreshedAt: account.lastRefreshedAt?.toISOString() ?? null,
        createdAt: account.createdAt.toISOString(),
      }}
    />
  );
}
