import { NextResponse } from "next/server";
import { requireUser, unauthenticatedResponse } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ASSET_BUCKET } from "@/lib/env";
import { getStudio } from "@/lib/repository";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase, user } = await requireUser();
    const { data: project, error } = await supabase
      .from("projects")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error || !project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const admin = createAdminClient();
    const payload = await getStudio(admin, id);
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return unauthenticatedResponse();
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load studio." }, { status: 500 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase, user } = await requireUser();
    const { data: project } = await supabase
      .from("projects")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    const admin = createAdminClient();
    const [{ data: storedFiles, error: listError }, { data: takes, error: takeError }] =
      await Promise.all([
        admin.storage.from(ASSET_BUCKET).list(`${user.id}/${id}`, {
          limit: 1000,
        }),
        admin.from("clip_takes").select("storage_path").eq("project_id", id),
      ]);
    if (listError) throw new Error(listError.message);
    if (takeError) throw new Error(takeError.message);

    const paths = [
      ...new Set(
        [
          ...(storedFiles ?? []).map(
            (file) => `${user.id}/${id}/${file.name}`
          ),
          ...(takes ?? []).map((take) => take.storage_path),
        ]
          .filter((path): path is string => Boolean(path))
      ),
    ];
    if (paths.length) {
      const { error } = await admin.storage.from(ASSET_BUCKET).remove(paths);
      if (error) throw new Error(`Could not remove project media: ${error.message}`);
    }

    const { error: deleteError } = await supabase
      .from("projects")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
    if (deleteError) throw new Error(deleteError.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") {
      return unauthenticatedResponse();
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not delete project." },
      { status: 500 }
    );
  }
}
