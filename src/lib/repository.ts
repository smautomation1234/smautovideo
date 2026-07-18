import { ASSET_BUCKET } from "@/lib/env";
import { TIMELINE_FPS } from "@/features/timeline/constants";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Asset, Clip, ClipTake, GenerationJob, JobEvent, JobKind, Project, StudioPayload, Timeline, TimelineItem } from "@/lib/types";

type DB = ReturnType<typeof createAdminClient>;

export async function getProject(db: DB, id: string) {
  const { data, error } = await db.from("projects").select("*").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data as Project;
}

export async function updateProject(db: DB, id: string, updates: Record<string, unknown>) {
  const { data, error } = await db.from("projects").update(updates).eq("id", id).select().single();
  if (error) throw new Error(error.message);
  return data as Project;
}

export async function enqueueJob(db: DB, input: { projectId: string; kind: JobKind; sequence: number; idempotencyKey: string; payload?: Record<string, unknown>; maxAttempts?: number }) {
  const { data, error } = await db.from("generation_jobs").upsert({
    project_id: input.projectId, kind: input.kind, sequence: input.sequence,
    idempotency_key: input.idempotencyKey, payload: input.payload ?? {},
    max_attempts: input.maxAttempts ?? 3, status: "queued"
  }, { onConflict: "idempotency_key", ignoreDuplicates: true }).select().maybeSingle();
  if (error) throw new Error(error.message);
  return data as GenerationJob | null;
}

export async function claimJob(db: DB) {
  const { data, error } = await db.rpc("claim_next_generation_job", {
    lease_seconds: 600,
  });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data[0] : data) as GenerationJob | null;
}

export async function updateJob(db: DB, id: string, updates: Record<string, unknown>) {
  const { data, error } = await db.from("generation_jobs").update(updates).eq("id", id).select().single();
  if (error) throw new Error(error.message);
  return data as GenerationJob;
}

export async function event(db: DB, jobId: string, level: JobEvent["level"], message: string, metadata: Record<string, unknown> = {}) {
  const { error } = await db.from("job_events").insert({ job_id: jobId, level, message, metadata });
  if (error) throw new Error(error.message);
}

export async function presenterAsset(db: DB, projectId: string) {
  const { data, error } = await db.from("project_assets").select("*").eq("project_id", projectId).eq("role", "presenter_image").maybeSingle();
  if (error) throw new Error(error.message);
  return data as Asset | null;
}

export async function getTake(db: DB, id: string) {
  const { data, error } = await db.from("clip_takes").select("*").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data as ClipTake;
}

export async function getClip(db: DB, id: string) {
  const { data, error } = await db.from("clips").select("*").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data as Clip;
}

const signedUrlCache = new Map<string, { url: string; expires: number }>();

const MAX_SIGNED_URL_CACHE_ENTRIES = 500;

async function getCachedSignedUrl(db: DB, path: string, expirySeconds: number = 3600): Promise<string> {
  const cacheKey = `${ASSET_BUCKET}:${path}`;
  const cached = signedUrlCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expires > now + 300 * 1000) {
    return cached.url;
  }
  const { data, error } = await db.storage.from(ASSET_BUCKET).createSignedUrl(path, expirySeconds);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Failed to generate signed URL");
  }
  signedUrlCache.set(cacheKey, {
    url: data.signedUrl,
    expires: now + expirySeconds * 1000
  });
  while (signedUrlCache.size > MAX_SIGNED_URL_CACHE_ENTRIES) {
    const oldest = signedUrlCache.keys().next().value;
    if (!oldest) break;
    signedUrlCache.delete(oldest);
  }
  return data.signedUrl;
}

export async function getStudio(db: DB, projectId: string): Promise<StudioPayload> {
  const project = await getProject(db, projectId);
  const [assetsResult, clipsResult, takesResult, jobsResult] = await Promise.all([
    db.from("project_assets").select("*").eq("project_id", projectId),
    db.from("clips").select("*").eq("project_id", projectId).order("clip_number"),
    db.from("clip_takes").select("*").eq("project_id", projectId).order("take_number"),
    db.from("generation_jobs").select("*").eq("project_id", projectId).order("created_at")
  ]);
  for (const result of [assetsResult, clipsResult, takesResult, jobsResult]) {
    if (result.error) throw new Error(result.error.message);
  }
  const assets = assetsResult.data ?? [];
  const clips = clipsResult.data ?? [];
  const takes = takesResult.data ?? [];
  const jobs = jobsResult.data ?? [];

  const signed = new Map<string, string>();
  const paths = new Set<string>();
  for (const asset of assets as Asset[]) paths.add(asset.storage_path);
  for (const take of takes as ClipTake[]) {
    if (take.storage_path) paths.add(take.storage_path);
  }
  for (const clip of clips as Clip[]) {
    if (clip.source_chunk_path) paths.add(clip.source_chunk_path);
  }
  await Promise.all([...paths].map(async (path) => {
    try {
      signed.set(path, await getCachedSignedUrl(db, path, 3600));
    } catch (error) {
      console.warn(`Could not sign project asset ${path}:`, error);
    }
  }));

  const presenter = (assets as Asset[]).find((a) => a.role === "presenter_image");
  const jobIds = (jobs as GenerationJob[]).map((j) => j.id);
  let events: JobEvent[] = [];
  if (jobIds.length) {
    const { data, error } = await db
      .from("job_events")
      .select("*")
      .in("job_id", jobIds)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    events = (data ?? []) as JobEvent[];
  }

  let timeline: (Timeline & { items: TimelineItem[] }) | undefined;
  if ((clips as Clip[]).length) {
    const { data: ensuredTimeline, error: ensureError } = await db.rpc(
      "ensure_project_timeline",
      {
        p_project_id: projectId,
        p_fps: TIMELINE_FPS,
      }
    );
    if (ensureError) throw new Error(ensureError.message);
    const timelineRow = Array.isArray(ensuredTimeline)
      ? ensuredTimeline[0]
      : ensuredTimeline;
    const { data: itemRows, error: itemError } = await db
      .from("timeline_items")
      .select("*")
      .eq("timeline_id", timelineRow.id)
      .order("order_index");
    if (itemError) throw new Error(itemError.message);
    timeline = {
      ...(timelineRow as Timeline),
      items: (itemRows ?? []) as TimelineItem[],
    };
  }

  return {
    project,
    presenter: presenter ? { ...presenter, signed_url: signed.get(presenter.storage_path) } : undefined,
    clips: (clips as Clip[]).map((clip) => ({
      ...clip,
      signed_source_url: clip.source_chunk_path ? signed.get(clip.source_chunk_path) : undefined,
      takes: (takes as ClipTake[]).filter((take) => take.clip_id === clip.id).map((take) => ({ ...take, signed_url: take.storage_path ? signed.get(take.storage_path) : undefined }))
    })),
    timeline,
    jobs: jobs as GenerationJob[], events
  };
}
