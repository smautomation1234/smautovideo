import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthenticatedResponse } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildEditVideoPrompt } from "@/features/video-import/edit-prompt";

const segmentSchema = z.object({
  chunk_number: z.number().int().positive(),
  storage_path: z.string().min(1),
  duration_seconds: z.number().positive(),
  omni_duration: z.number().int().min(0).max(10),
  append_raw: z.boolean().default(false),
});

const bodySchema = z.object({
  segments: z.array(segmentSchema).min(1).max(100),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase, user } = await requireUser();

    // Verify project ownership and mode
    const { data: project } = await supabase
      .from("projects")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    if (project.mode !== "edit_video") return NextResponse.json({ error: "This project is not in edit video mode." }, { status: 400 });


    const { segments } = bodySchema.parse(await request.json());

    const db = createAdminClient();

    const omniSegments = segments.filter((s) => s.omni_duration > 0);
    const rawSegments = segments.filter((s) => s.append_raw);

    if (omniSegments.length === 0) {
      return NextResponse.json({ error: "No segments to process." }, { status: 400 });
    }

    const preparedSegments = segments.map((segment) => ({
      chunk_number: segment.chunk_number,
      storage_path: segment.storage_path,
      source_duration_seconds: segment.duration_seconds,
      omni_duration: segment.omni_duration,
      append_raw: segment.append_raw,
      spoken_line: segment.omni_duration > 0
        ? `[Edit mode] Segment ${segment.chunk_number} — original audio preserved`
        : `[Raw tail] ${segment.duration_seconds.toFixed(1)}s appended without editing`,
      prompt: segment.omni_duration > 0
        ? buildEditVideoPrompt({
            aspectRatio: project.aspect_ratio,
            resolution: project.resolution || "720p",
            durationSeconds: segment.omni_duration,
          })
        : "Raw footage — no Omni processing needed",
    }));
    const { data: result, error } = await db.rpc("configure_edit_project", {
      p_project_id: id,
      p_user_id: user.id,
      p_segments: preparedSegments,
    });
    if (error) throw new Error(error.message);

    return NextResponse.json({
      ok: true,
      clipCount: Number(result?.clip_count ?? omniSegments.length),
      rawAppendCount: Number(result?.raw_append_count ?? rawSegments.length),
      message: "Edit pipeline configured. Please review and approve prompts to start generation.",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return unauthenticatedResponse();
    return NextResponse.json({ error: error instanceof Error ? error.message : "Edit run failed." }, { status: 400 });
  }
}
