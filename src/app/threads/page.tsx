import { redirect } from "next/navigation";
import { ENABLE_THREADS } from "@/lib/modules";
import { ThreadsOverviewPage } from "@/components/threads/threads-overview-page";

export default function ThreadsPage() {
  if (!ENABLE_THREADS) redirect("/");
  return <ThreadsOverviewPage />;
}
