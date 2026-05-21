import { prisma } from "@/lib/db";
import { getCurrentRole } from "@/lib/creator-auth";
import { CreatorSheet } from "@/components/creators/creator-sheet";
import { CreatorLoginForm } from "@/components/creators/creator-login-form";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const creator = await prisma.creator.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true, accessUsername: true, accessPassword: true },
  });

  if (!creator) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 text-gray-900">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Sheet not found</h1>
          <p className="mt-2 text-sm text-gray-600">No creator with the slug "{slug}" exists.</p>
        </div>
      </div>
    );
  }

  const role = await getCurrentRole(creator.id);
  if (!role) {
    return <CreatorLoginForm slug={slug} creatorName={creator.name} />;
  }

  return <CreatorSheet slug={slug} role={role} />;
}
