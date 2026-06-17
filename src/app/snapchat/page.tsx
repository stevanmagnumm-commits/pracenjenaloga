import { redirect } from "next/navigation";
import { ENABLE_SNAPCHAT } from "@/lib/modules";
import { SnapchatAccountsPage } from "@/components/snapchat/snapchat-accounts-page";

export default function SnapchatPage() {
  if (!ENABLE_SNAPCHAT) redirect("/");
  return <SnapchatAccountsPage />;
}
