import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudio } from "@/lib/repository";
import { StudioClient } from "@/components/studio-client";

export default async function ProjectStudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await requireUser().catch(() => redirect("/login"));
  const { data: ownedProject } = await supabase
    .from("projects")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!ownedProject) notFound();
  const admin = createAdminClient();
  const payload = await getStudio(admin, id);

  return (
    <main className="studio-shell editor-route-shell">
      <StudioClient initial={payload} />
    </main>
  );
}
