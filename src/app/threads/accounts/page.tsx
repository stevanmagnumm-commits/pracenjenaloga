import { redirect } from "next/navigation";
import { ENABLE_THREADS } from "@/lib/modules";
import { ThreadsAccountsPage } from "@/components/threads/threads-accounts-page";

export default function ThreadsAccountsRoute() {
  if (!ENABLE_THREADS) redirect("/");
  return <ThreadsAccountsPage />;
}
