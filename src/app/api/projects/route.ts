import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthenticatedResponse } from "@/lib/auth";

const schema = z.object({
  title: z.string().trim().min(2).max(180),
  raw_post: z.string().trim().min(1).max(30000),
  target_duration_seconds: z.number().int().min(4).max(300),
  aspect_ratio: z.enum(["9:16", "16:9"]),
  resolution: z.literal("720p"),
  style: z.literal("paper_motion"),
  mode: z.enum(["from_scratch", "edit_video"]).default("from_scratch"),
});

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireUser();
    const input = schema.parse(await request.json());
    const { data, error } = await supabase
      .from("projects")
      .insert({ ...input, user_id: user.id })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ project: data }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return unauthenticatedResponse();
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid project request." }, { status: 400 });
  }
}
