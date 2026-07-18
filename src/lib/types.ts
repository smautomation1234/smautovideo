export type AspectRatio = "9:16" | "16:9";
export type ProjectMode = "from_scratch" | "edit_video";
export type ProjectState = "draft" | "planning" | "review" | "generating" | "ready" | "attention";
export type JobKind = "prompt_plan" | "omni_take";
export type JobStatus =
  | "queued" | "processing" | "submitting" | "waiting_external" | "completed"
  | "retryable" | "failed" | "uncertain" | "cancelled";
export type AssetRole = "presenter_image" | "generated_clip" | "source_video_chunk";

export interface Project {
  id: string;
  user_id: string;
  title: string;
  raw_post: string;
  target_duration_seconds: number;
  aspect_ratio: AspectRatio;
  resolution: "720p";
  style: "paper_motion";
  mode: ProjectMode;
  state: ProjectState;
  prompt_plan: ReelPlan | null;
  prompt_approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReelPlan {
  fact_check_notes: string;
  source_urls: Array<{ title: string; url: string }>;
  dense_fraction: number;
  word_ceiling: number;
  actual_word_count: number;
  full_script: string;
  clips: PlannedClip[];
}

export interface PlannedClip {
  clip_number: number;
  duration_seconds: 4 | 6 | 8 | 10;
  spoken_line: string;
  prompt: string;
}

export interface Clip {
  id: string;
  project_id: string;
  clip_number: number;
  duration_seconds: number;
  spoken_line: string;
  prompt: string;
  source_chunk_path: string | null;
  signed_source_url?: string;
  created_at: string;
}

export interface ClipTake {
  id: string;
  project_id: string;
  clip_id: string;
  take_number: number;
  status: JobStatus;
  selected: boolean;
  trim_start_seconds: number;
  trim_end_seconds: number | null;
  storage_path: string | null;
  provider_interaction_id: string | null;
  provider_payload: Record<string, unknown>;
  last_error: string | null;
  error_category?: string | null;
  error_code?: string | null;
  error_details?: Record<string, unknown>;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
  signed_url?: string;
}

export interface Asset {
  id: string;
  project_id: string;
  owner_id: string;
  role: AssetRole;
  storage_path: string;
  content_type: string;
  created_at: string;
  signed_url?: string;
}

export interface GenerationJob {
  id: string;
  project_id: string;
  kind: JobKind;
  status: JobStatus;
  sequence: number;
  idempotency_key: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  external_response_id: string | null;
  attempt_count: number;
  error_count: number;
  max_attempts: number;
  run_after: string;
  locked_until: string | null;
  last_error: string | null;
  error_category?: string | null;
  error_code?: string | null;
  error_details?: Record<string, unknown>;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobEvent {
  id: string;
  job_id: string;
  level: "info" | "warning" | "error";
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Timeline {
  id: string;
  project_id: string;
  fps: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TimelineItem {
  id: string;
  timeline_id: string;
  clip_id: string;
  take_id: string | null;
  order_index: number;
  source_in_frame: number;
  source_out_frame: number;
  volume: number;
  muted: boolean;
  created_at: string;
  updated_at: string;
}

export interface StudioPayload {
  project: Project;
  presenter?: Asset;
  clips: Array<Clip & { takes: ClipTake[] }>;
  timeline?: Timeline & { items: TimelineItem[] };
  jobs: GenerationJob[];
  events: JobEvent[];
}
