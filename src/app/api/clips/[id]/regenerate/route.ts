import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthenticatedResponse } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const input = z.object({
  prompt: z.string().trim().min(20).max(30000).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = input.parse(await request.json().catch(() => ({})));
    const { supabase, user } = await requireUser();
    const { data: ownedClip } = await supabase
      .from("clips")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (!ownedClip) return NextResponse.json({ error: "Clip not found." }, { status: 404 });
    const admin = createAdminClient();
    const { data: take, error } = await admin.rpc("create_regeneration_take", {
      p_clip_id: id,
      p_user_id: user.id,
      p_prompt: body.prompt ?? null,
    });
    if (error) throw new Error(error.message);
    return NextResponse.json({ take }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return unauthenticatedResponse();
    return NextResponse.json({ error: error instanceof Error ? error.message : "Regeneration failed." }, { status: 400 });
  }
}
