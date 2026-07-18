import { NextResponse } from "next/server";
import { requireUser, unauthenticatedResponse } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueJob, updateProject } from "@/lib/repository";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase, user } = await requireUser();
    const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("user_id", user.id).maybeSingle();
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const { data: image } = await supabase.from("project_assets").select("id").eq("project_id", id).eq("role", "presenter_image").maybeSingle();
    if (!image) return NextResponse.json({ error: "Upload your presenter photo first." }, { status: 400 });
    const db = createAdminClient();
    await enqueueJob(db, { projectId: id, kind: "prompt_plan", sequence: 10, idempotencyKey: `${id}:prompt-plan:v1`, maxAttempts: 2 });
    await updateProject(db, id, { state: "planning" });
    return NextResponse.json({ ok: true, message: "Gemini planning queued. The server continues if the browser disconnects." });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return unauthenticatedResponse();
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not start project." }, { status: 500 });
  }
}
