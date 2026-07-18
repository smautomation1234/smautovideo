-- ReelForge Omni v2: initial database schema.
create extension if not exists pgcrypto;

do $$ begin create type public.project_state as enum ('draft','planning','review','generating','ready','attention'); exception when duplicate_object then null; end $$;
do $$ begin create type public.asset_role as enum ('presenter_image','generated_clip'); exception when duplicate_object then null; end $$;
do $$ begin create type public.job_kind as enum ('prompt_plan','omni_take'); exception when duplicate_object then null; end $$;
do $$ begin create type public.job_status as enum ('queued','processing','submitting','waiting_external','completed','retryable','failed','uncertain','cancelled'); exception when duplicate_object then null; end $$;
do $$ begin create type public.event_level as enum ('info','warning','error'); exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text, display_name text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 180),
  raw_post text not null check (char_length(raw_post) between 1 and 30000),
  target_duration_seconds integer not null check (target_duration_seconds between 4 and 300),
  aspect_ratio text not null check (aspect_ratio in ('9:16','16:9')) default '9:16',
  resolution text not null check (resolution = '720p') default '720p',
  style text not null check (style = 'paper_motion') default 'paper_motion',
  state public.project_state not null default 'draft',
  prompt_plan jsonb, prompt_approved_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.project_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  role public.asset_role not null,
  storage_path text not null unique,
  content_type text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists one_presenter_per_project on public.project_assets(project_id, role) where role='presenter_image';

create table if not exists public.clips (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  clip_number integer not null check (clip_number > 0),
  duration_seconds integer not null check (duration_seconds between 1 and 300),
  spoken_line text not null,
  prompt text not null,
  created_at timestamptz not null default now(),
  unique(project_id, clip_number)
);

create table if not exists public.clip_takes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  clip_id uuid not null references public.clips(id) on delete cascade,
  take_number integer not null check (take_number > 0),
  status public.job_status not null default 'queued',
  selected boolean not null default false,
  trim_start_seconds numeric(6,3) not null default 0 check (trim_start_seconds >= 0),
  trim_end_seconds numeric(6,3),
  storage_path text,
  provider_interaction_id text,
  provider_payload jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(clip_id, take_number)
);

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  kind public.job_kind not null, status public.job_status not null default 'queued',
  sequence integer not null, idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb, result jsonb,
  external_response_id text, attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  run_after timestamptz not null default now(), locked_until timestamptz,
  last_error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists jobs_dispatch on public.generation_jobs(status,run_after,sequence,created_at);

create table if not exists public.job_events (
  id uuid primary key default gen_random_uuid(), job_id uuid not null references public.generation_jobs(id) on delete cascade,
  level public.event_level not null default 'info', message text not null,
  metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
drop trigger if exists projects_updated_at on public.projects;
create trigger projects_updated_at before update on public.projects for each row execute function public.set_updated_at();
drop trigger if exists takes_updated_at on public.clip_takes;
create trigger takes_updated_at before update on public.clip_takes for each row execute function public.set_updated_at();
drop trigger if exists jobs_updated_at on public.generation_jobs;
create trigger jobs_updated_at before update on public.generation_jobs for each row execute function public.set_updated_at();

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into public.profiles(id,email,display_name) values(new.id,new.email,coalesce(new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'name')) on conflict(id) do update set email=excluded.email,display_name=excluded.display_name; return new; end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

create or replace function public.claim_next_generation_job(lease_seconds integer default 300)
returns setof public.generation_jobs language plpgsql security definer set search_path=public as $$
declare claimed_id uuid;
begin
  select id into claimed_id from public.generation_jobs
  where ((status in ('queued','retryable','waiting_external') and run_after<=now() and (locked_until is null or locked_until<now()))
     or (status='processing' and locked_until<now()))
  order by sequence,created_at for update skip locked limit 1;
  if claimed_id is null then return; end if;
  return query update public.generation_jobs set status='processing',attempt_count=attempt_count+1,locked_until=now()+make_interval(secs=>lease_seconds) where id=claimed_id returning *;
end $$;

create or replace function public.quarantine_stale_submissions(stale_after_seconds integer default 900)
returns integer language plpgsql security definer set search_path=public as $$
declare affected integer;
begin
  with q as (update public.generation_jobs set status='uncertain',locked_until=null,last_error='Provider outcome unknown; automatic replay blocked to protect credits.' where status='submitting' and updated_at<now()-make_interval(secs=>stale_after_seconds) returning project_id)
  select count(*) into affected from q;
  update public.projects set state='attention' where id in (select project_id from public.generation_jobs where status='uncertain');
  return affected;
end $$;

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_assets enable row level security;
alter table public.clips enable row level security;
alter table public.clip_takes enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.job_events enable row level security;
drop policy if exists "profiles own" on public.profiles; create policy "profiles own" on public.profiles for select to authenticated using(id=auth.uid());
drop policy if exists "projects own" on public.projects; create policy "projects own" on public.projects for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
drop policy if exists "assets own" on public.project_assets; create policy "assets own" on public.project_assets for select to authenticated using(owner_id=auth.uid());
drop policy if exists "assets insert own" on public.project_assets; create policy "assets insert own" on public.project_assets for insert to authenticated with check(owner_id=auth.uid() and exists(select 1 from public.projects p where p.id=project_id and p.user_id=auth.uid()));
drop policy if exists "clips own" on public.clips; create policy "clips own" on public.clips for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.user_id=auth.uid()));
drop policy if exists "takes own" on public.clip_takes; create policy "takes own" on public.clip_takes for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.user_id=auth.uid()));
drop policy if exists "jobs own" on public.generation_jobs; create policy "jobs own" on public.generation_jobs for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.user_id=auth.uid()));
drop policy if exists "events own" on public.job_events; create policy "events own" on public.job_events for select to authenticated using(exists(select 1 from public.generation_jobs j join public.projects p on p.id=j.project_id where j.id=job_id and p.user_id=auth.uid()));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('project-assets','project-assets',false,524288000,array['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
