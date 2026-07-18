"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function signIn() {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=/studio` }
    });
    if (signInError) {
      setError(signInError.message);
      setLoading(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">REELFORGE OMNI</p>
        <h1>Turn one post into<br />a finished AI Reel.</h1>
        <p className="muted">Fact-checked Gemini prompts, human approval, identity-consistent Omni clips, selectable regeneration takes, trimming and MP4 export.</p>
        <button className="button button-primary" onClick={signIn} disabled={loading}>
          {loading ? "Connecting…" : "Continue with Google"}
        </button>
        {error && <p className="form-error">{error}</p>}
        <p className="small muted">Google Cloud and Supabase service credentials remain server-only and never reach the browser.</p>
      </section>
    </main>
  );
}
