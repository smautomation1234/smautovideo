import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, unauthenticatedResponse } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const input = z.object({ selected: z.boolean().optional(), trim_start_seconds: z.number().min(0).max(10).optional(), trim_end_seconds: z.number().min(0).max(10).optional() });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const values = input.parse(await request.json());
    const { supabase, user } = await requireUser();
    const { data: ownedTake } = await supabase
      .from("clip_takes")
      .select("id,clip_id,trim_start_seconds,trim_end_seconds")
      .eq("id", id)
      .maybeSingle();
    if (!ownedTake) return NextResponse.json({ error: "Take not found." }, { status: 404 });
    const admin = createAdminClient();
    const trimStart = values.trim_start_seconds ?? Number(ownedTake.trim_start_seconds);
    const trimEnd = values.trim_end_seconds ?? (
      ownedTake.trim_end_seconds === null ? null : Number(ownedTake.trim_end_seconds)
    );
    if (trimEnd !== null && trimEnd <= trimStart) {
      return NextResponse.json({ error: "Trim end must be after trim start." }, { status: 400 });
    }

    let selectedTake = null;
    if (values.selected === true) {
      const { data, error } = await admin.rpc("select_clip_take", {
        p_take_id: id,
        p_user_id: user.id,
      });
      if (error) throw new Error(error.message);
      selectedTake = data;
    }

    const directUpdates = {
      ...(values.selected === false ? { selected: false } : {}),
      ...(values.trim_start_seconds !== undefined
        ? { trim_start_seconds: values.trim_start_seconds }
        : {}),
      ...(values.trim_end_seconds !== undefined
        ? { trim_end_seconds: values.trim_end_seconds }
        : {}),
    };
    if (Object.keys(directUpdates).length) {
      const { data, error } = await admin
        .from("clip_takes")
        .update(directUpdates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ take: data });
    }

    return NextResponse.json({ take: selectedTake });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") return unauthenticatedResponse();
    return NextResponse.json({ error: error instanceof Error ? error.message : "Update failed." }, { status: 400 });
  }
}
