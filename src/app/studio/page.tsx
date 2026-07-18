import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ModeSelector } from "@/components/mode-selector";
import type { ProjectMode } from "@/lib/types";

export default async function StudioPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: projects } = await supabase
    .from("projects")
    .select("id,title,state,aspect_ratio,target_duration_seconds,created_at,mode")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <main className="shell">
      <header className="topbar">
        <Link href="/studio" className="wordmark">REELFORGE <span>OMNI</span></Link>
        <form action="/auth/signout"><span className="user-chip">{user.email}</span></form>
      </header>
      <section className="hero">
        <div>
          <p className="eyebrow">AUTOMATED OMNI REEL STUDIO</p>
          <h1>One photo. Approved prompts.<br />Selectable video takes.</h1>
        </div>
        <p className="muted hero-note">Gemini fact-checks and fits the script. You approve the visible prompts, Omni generates each clip with the same attached presenter image, and you choose which takes enter the final scene.</p>
      </section>
      <div className="dashboard-grid">
        <ModeSelector />
        <section className="project-list panel">
          <div className="section-title"><h2>Recent projects</h2><span>{projects?.length ?? 0}</span></div>
          {!projects?.length && <p className="muted empty">Your first pipeline will appear here.</p>}
          <div className="projects">
            {projects?.map((project) => (
              <Link key={project.id} href={`/studio/${project.id}`} className="project-row">
                <div><strong>{project.title}</strong><span>{(project.mode as ProjectMode) === "edit_video" ? "✂️ " : ""}{project.aspect_ratio} · {project.target_duration_seconds}s</span></div>
                <span className={`status status-${project.state}`}>{project.state}</span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
