import { NextResponse } from "next/server";
import { z } from "zod";
import { TIMELINE_FPS } from "@/features/timeline/constants";
import { requireUser, unauthenticatedResponse } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudio } from "@/lib/repository";

export const dynamic = "force-dynamic";

const timelineItemSchema = z.object({
  id: z.string().uuid(),
  clip_id: z.string().uuid(),
  take_id: z.string().uuid().nullable(),
  source_in_frame: z.number().int().min(0),
  source_out_frame: z.number().int().positive(),
  volume: z.number().min(0).max(1).default(1),
  muted: z.boolean().default(false),
}).refine((item) => item.source_out_frame > item.source_in_frame, {
  message: "Every timeline item must contain at least one frame.",
});

const saveSchema = z.object({
  expected_version: z.number().int().positive(),
  fps: z.literal(TIMELINE_FPS),
  items: z.array(timelineItemSchema).max(500),
});

async function ownedProject(id: string) {
  const { supabase, user } = await requireUser();
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  return { user, project };
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { project } = await ownedProject(id);
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const payload = await getStudio(createAdminClient(), id);
    return NextResponse.json({ timeline: payload.timeline ?? null });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return unauthenticatedResponse();
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load timeline." }, { status: 500 });
  }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { user, project } = await ownedProject(id);
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const input = saveSchema.parse(await request.json());
    const db = createAdminClient();

    const clipIds = [...new Set(input.items.map((item) => item.clip_id))];
    if (clipIds.length) {
      const { data: clips, error: clipsError } = await db
        .from("clips")
        .select("id,duration_seconds")
        .eq("project_id", id)
        .in("id", clipIds);
      if (clipsError) throw new Error(clipsError.message);
      if ((clips ?? []).length !== clipIds.length) {
        return NextResponse.json(
          { error: "A timeline clip does not belong to this project." },
          { status: 400 }
        );
      }
      const frameLimits = new Map(
        (clips ?? []).map((clip: { id: string; duration_seconds: number }) => [
          clip.id,
          Math.max(1, Math.round(Number(clip.duration_seconds) * input.fps)),
        ])
      );
      const outsideSource = input.items.find(
        (item) =>
          item.source_out_frame > (frameLimits.get(item.clip_id) ?? 0)
      );
      if (outsideSource) {
        return NextResponse.json(
          {
            error:
              "A trim range extends past the final frame of its source clip.",
          },
          { status: 400 }
        );
      }
    }

    const takeIds = [
      ...new Set(
        input.items
          .map((item) => item.take_id)
          .filter((takeId): takeId is string => Boolean(takeId))
      ),
    ];
    if (takeIds.length) {
      const { data: takes, error: takesError } = await db
        .from("clip_takes")
        .select("id,clip_id")
        .eq("project_id", id)
        .in("id", takeIds);
      if (takesError) throw new Error(takesError.message);
      const takeToClip = new Map(
        (takes ?? []).map((take: { id: string; clip_id: string }) => [
          take.id,
          take.clip_id,
        ])
      );
      if (
        (takes ?? []).length !== takeIds.length ||
        input.items.some(
          (item) => item.take_id && takeToClip.get(item.take_id) !== item.clip_id
        )
      ) {
        return NextResponse.json(
          { error: "A timeline take does not belong to its clip." },
          { status: 400 }
        );
      }
    }

    const { data, error } = await db.rpc("save_timeline_document", {
      p_project_id: id,
      p_user_id: user.id,
      p_expected_version: input.expected_version,
      p_fps: input.fps,
      p_items: input.items,
    });
    if (error) {
      if (error.message.includes("TIMELINE_VERSION_CONFLICT")) {
        return NextResponse.json({ error: "Timeline changed in another tab. Reload before saving." }, { status: 409 });
      }
      throw new Error(error.message);
    }
    const result = Array.isArray(data) ? data[0] : data;
    return NextResponse.json({
      timeline_id: result?.timeline_id,
      version: result?.new_version,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return unauthenticatedResponse();
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message || "Invalid timeline." }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Timeline save failed." }, { status: 500 });
  }
}
