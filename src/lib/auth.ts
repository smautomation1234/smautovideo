import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function requireUser() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("UNAUTHENTICATED");
  return { supabase, user };
}

export function unauthenticatedResponse() {
  return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
}
