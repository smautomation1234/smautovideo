-- Structured provider errors and stable generation timestamps for the live
-- table-view progress experience. Re-running this migration is safe.

alter table public.generation_jobs
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists error_category text,
  add column if not exists error_code text,
  add column if not exists error_details jsonb not null default '{}'::jsonb;

alter table public.clip_takes
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists error_category text,
  add column if not exists error_code text,
  add column if not exists error_details jsonb not null default '{}'::jsonb;

update public.generation_jobs
set started_at = created_at
where started_at is null
  and status not in ('queued', 'cancelled');

update public.generation_jobs
set completed_at = updated_at
where completed_at is null
  and status = 'completed';

update public.clip_takes
set started_at = created_at
where started_at is null
  and status not in ('queued', 'cancelled');

update public.clip_takes
set completed_at = updated_at
where completed_at is null
  and status = 'completed';

create index if not exists generation_jobs_project_started
  on public.generation_jobs(project_id, started_at, created_at);

