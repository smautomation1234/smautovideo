import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthenticatedResponse } from "@/lib/auth";

const schema = z.object({
  path: z.string().min(1),
  content_type: z.enum(["image/jpeg", "image/png", "image/webp"])
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase, user } = await requireUser();
    const input = schema.parse(await request.json());
    if (!input.path.startsWith(`${user.id}/${id}/raw-`)) {
      return NextResponse.json({ error: "Invalid upload path." }, { status: 400 });
    }
    const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("user_id", user.id).maybeSingle();
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const { data: existing } = await supabase.from("project_assets").select("id").eq("project_id", id).eq("role", "presenter_image").maybeSingle();
    if (existing) return NextResponse.json({ error: "This project already has a presenter image." }, { status: 409 });
    const { data, error } = await supabase.from("project_assets").insert({
      project_id: id,
      owner_id: user.id,
      role: "presenter_image",
      storage_path: input.path,
      content_type: input.content_type
    }).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ asset: data }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return unauthenticatedResponse();
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not confirm upload." }, { status: 400 });
  }
}
