type RequiredEnvironmentVariable =
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
  | "GEMINI_API_KEY"
  | "GOOGLE_CLOUD_PROJECT";

export function requireEnv<T extends RequiredEnvironmentVariable>(name: T): string {
  if (name === "NEXT_PUBLIC_SUPABASE_URL") {
    const val = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!val) throw new Error(`Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL`);
    return val;
  }
  if (name === "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") {
    const val = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!val) throw new Error(`Missing required environment variable: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`);
    return val;
  }
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function requireSupabaseSecret() {
  const value =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) {
    throw new Error(
      "Missing SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY)."
    );
  }
  return value;
}

export const ASSET_BUCKET = "project-assets";
export const TEXT_MODEL = "gemini-2.5-flash";
export const OMNI_MODEL = "gemini-omni-flash-preview";
export const GOOGLE_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "global";
