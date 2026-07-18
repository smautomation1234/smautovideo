"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const initial = { title: "", raw_post: "", target_duration_seconds: 30, aspect_ratio: "9:16", resolution: "720p", style: "paper_motion", mode: "from_scratch" } as const;

export function NewProjectForm() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<Record<string, string | number>>({ ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return setError("Choose the presenter photo that must be attached to every Omni prompt.");
    setBusy(true); setError(null);
    let projectId: string | null = null;
    try {
      const created = await jsonFetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      projectId = created.project.id;
      const signed = await jsonFetch(`/api/projects/${projectId}/assets/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: file.name, type: file.type, size: file.size }) });
      const { error: uploadError } = await createClient().storage.from("project-assets").uploadToSignedUrl(signed.path, signed.token, file, { contentType: file.type });
      if (uploadError) throw new Error(uploadError.message);
      await jsonFetch(`/api/projects/${projectId}/assets/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: signed.path, content_type: file.type }) });
      await jsonFetch(`/api/projects/${projectId}/run`, { method: "POST" });
      router.push(`/studio/${projectId}`);
    } catch (caught) {
      if (projectId) {
        await fetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
      }
      setError(caught instanceof Error ? caught.message : "Creation failed.");
      setBusy(false);
    }
  }

  return <form className="panel project-form" onSubmit={submit}>
    <div className="section-title"><h2>New automated Reel</h2><span>Gemini → Omni</span></div>
    <label>Project title<input required value={String(form.title)} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Grok 4.5 launch explained" /></label>
    <label>Raw post or script<textarea required rows={11} value={String(form.raw_post)} onChange={(e) => setForm({ ...form, raw_post: e.target.value })} placeholder="Paste the full source post. Gemini will fact-check, rewrite pronunciation, fit the duration and generate every clip prompt." /></label>
    <div className="two-columns">
      <label>Target duration<select value={String(form.target_duration_seconds)} onChange={(e) => setForm({ ...form, target_duration_seconds: Number(e.target.value) })}><option value="20">20 seconds</option><option value="30">30 seconds</option><option value="40">40 seconds</option><option value="60">60 seconds</option><option value="90">90 seconds</option></select></label>
      <label>Aspect ratio<select value={String(form.aspect_ratio)} onChange={(e) => setForm({ ...form, aspect_ratio: e.target.value })}><option value="9:16">9:16 · Instagram Reel</option><option value="16:9">16:9 · Landscape</option></select></label>
    </div>
    <div className="two-columns">
      <label>Resolution<select value="720p" disabled><option>720p · Omni fixed</option></select></label>
      <label>Visual style<select value="paper_motion" disabled><option>Paper Effect + Motion Graphics</option></select></label>
    </div>
    <label>Presenter photo<input ref={fileInput} required type="file" accept="image/png,image/jpeg,image/webp" /></label>
    <p className="field-help">The same literal file is attached to every Omni generation. Regeneration never replaces an earlier take.</p>
    {error && <p className="form-error">{error}</p>}
    <button className="button button-primary" disabled={busy}>{busy ? "Creating secure project…" : "Generate script and prompts"}</button>
  </form>;
}

async function jsonFetch(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new Error(`Server returned non-JSON response (${response.status}): ${text.substring(0, 150)}`);
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}
