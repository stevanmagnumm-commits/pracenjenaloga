import { notFound } from "next/navigation";
import { ENABLE_SECURITY } from "@/lib/modules";
import { SecurityPage } from "@/components/security/security-page";

export const dynamic = "force-dynamic";

export default function SecurityRoute() {
  if (!ENABLE_SECURITY) notFound();
  return <SecurityPage />;
}
