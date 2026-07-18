import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthenticatedResponse } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

const input = z.object({
  prompts: z.record(z.string().trim().min(20).max(30000)).default({}),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase, user } = await requireUser();
    const { data: project } = await supabase.from("projects").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    if (project.mode !== "edit_video" && !project.prompt_plan) {
      return NextResponse.json({ error: "Prompt plan is not ready." }, { status: 409 });
    }

    const db = createAdminClient();
    const body = input.parse(await request.json().catch(() => ({})));
    const { data: clipCount, error } = await db.rpc("approve_project_generation", {
      p_project_id: id,
      p_user_id: user.id,
      p_prompts: body.prompts,
    });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, clipCount: Number(clipCount || 0) });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return unauthenticatedResponse();
    return NextResponse.json({ error: error instanceof Error ? error.message : "Approval failed." }, { status: 400 });
  }
}
