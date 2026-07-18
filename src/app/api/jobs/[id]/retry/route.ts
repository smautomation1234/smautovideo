import { NextResponse } from "next/server";
import { requireUser, unauthenticatedResponse } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase, user } = await requireUser();
    const { data: job } = await supabase
      .from("generation_jobs")
      .select("id,project_id,status,external_response_id,projects!inner(user_id)")
      .eq("id", id)
      .eq("projects.user_id", user.id)
      .maybeSingle();
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
    if (job.status === "uncertain") {
      return NextResponse.json(
        {
          error:
            "This submission has an uncertain provider outcome. Automatic replay is blocked to prevent duplicate billing.",
        },
        { status: 409 }
      );
    }
    const db = createAdminClient();
    const status = job.external_response_id ? "waiting_external" : "queued";
    const { error } = await db
      .from("generation_jobs")
      .update({
        status,
        error_count: 0,
        last_error: null,
        error_category: null,
        error_code: null,
        error_details: {},
        completed_at: null,
        run_after: new Date().toISOString(),
        locked_until: null,
      })
      .eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return unauthenticatedResponse();
    return NextResponse.json({ error: error instanceof Error ? error.message : "Retry failed." }, { status: 400 });
  }
}
