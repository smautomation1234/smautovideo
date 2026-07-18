import { createClient } from "@supabase/supabase-js";
import { requireEnv, requireSupabaseSecret } from "@/lib/env";

export function createAdminClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireSupabaseSecret(),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      }
    }
  );
}
