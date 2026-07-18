import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthenticatedResponse } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ASSET_BUCKET } from "@/lib/env";

const inputSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm", "video/quicktime"]),
  size: z.number().int().positive().max(500 * 1024 * 1024)
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase, user } = await requireUser();
    const input = inputSchema.parse(await request.json());
    const { data: project } = await supabase.from("projects").select("id").eq("id", id).eq("user_id", user.id).maybeSingle();
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const extMap: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
    const extension = extMap[input.type] || "bin";
    const prefix = input.type.startsWith("video/") ? "chunk" : "raw";
    const path = `${user.id}/${id}/${prefix}-${crypto.randomUUID()}.${extension}`;
    const { data, error } = await createAdminClient().storage.from(ASSET_BUCKET).createSignedUploadUrl(path);
    if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not create secure upload URL." }, { status: 500 });
    return NextResponse.json({ path, token: data.token });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return unauthenticatedResponse();
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid upload request." }, { status: 400 });
  }
}
