-- ReelForge Omni v2: production hardening and atomic editor operations.
-- Safe to run after the first three migrations on an existing project.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault;

alter table public.generation_jobs
  add column if not exists error_count integer not null default 0
  check (error_count >= 0);

-- Preserve at most one selected take for every clip before enforcing it.
with ranked as (
  select
    id,
    row_number() over (
      partition by clip_id
      order by updated_at desc, take_number desc
    ) as selection_rank
  from public.clip_takes
  where selected
)
update public.clip_takes as take
set selected = false
from ranked
where take.id = ranked.id
  and ranked.selection_rank > 1;

create unique index if not exists one_selected_take_per_clip
  on public.clip_takes(clip_id)
  where selected;

create index if not exists jobs_dispatch_fair
  on public.generation_jobs(status, run_after, sequence, created_at)
  where status in ('queued', 'retryable', 'waiting_external', 'processing');

-- Claims new work before provider polling so one waiting clip cannot starve
-- the rest of a project's queued clips. Polling does not consume retry attempts.
create or replace function public.claim_next_generation_job(
  lease_seconds integer default 300
)
returns setof public.generation_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed_id uuid;
begin
  select id
  into claimed_id
  from public.generation_jobs
  where (
    status in ('queued', 'retryable', 'waiting_external')
    and run_after <= now()
    and (locked_until is null or locked_until < now())
  ) or (
    status = 'processing'
    and locked_until < now()
  )
  order by
    case status
      when 'queued' then 0
      when 'retryable' then 1
      when 'waiting_external' then 2
      else 3
    end,
    run_after,
    sequence,
    created_at
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  return query
  update public.generation_jobs
  set
    status = 'processing',
    attempt_count = attempt_count + case
      when external_response_id is null
        and status in ('queued', 'retryable')
      then 1
      else 0
    end,
    locked_until = now() + make_interval(secs => lease_seconds)
  where id = claimed_id
  returning *;
end;
$$;

create or replace function public.quarantine_stale_submissions(
  stale_after_seconds integer default 900
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer;
begin
  with quarantined as (
    update public.generation_jobs
    set
      status = 'uncertain',
      locked_until = null,
      last_error = 'Provider outcome unknown; automatic replay blocked to protect credits.'
    where status = 'submitting'
      and updated_at < now() - make_interval(secs => stale_after_seconds)
    returning project_id
  )
  select count(*) into affected from quarantined;

  update public.projects
  set state = 'attention'
  where id in (
    select project_id
    from public.generation_jobs
    where status = 'uncertain'
  );

  return affected;
end;
$$;

-- Selecting a take is a single transaction, so concurrent requests can never
-- leave two selected takes for one clip.
create or replace function public.select_clip_take(
  p_take_id uuid,
  p_user_id uuid
)
returns public.clip_takes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_take public.clip_takes;
begin
  select take.*
  into selected_take
  from public.clip_takes as take
  join public.projects as project on project.id = take.project_id
  where take.id = p_take_id
    and project.user_id = p_user_id
  for update of take;

  if selected_take.id is null then
    raise exception 'Take not found';
  end if;

  perform 1
  from public.clips
  where id = selected_take.clip_id
  for update;

  update public.clip_takes
  set selected = false
  where clip_id = selected_take.clip_id
    and selected;

  update public.clip_takes
  set selected = true
  where id = selected_take.id
  returning * into selected_take;

  return selected_take;
end;
$$;

-- Regeneration locks the clip before allocating its next take number. This
-- removes the application-side max()+1 race and creates the job atomically.
create or replace function public.create_regeneration_take(
  p_clip_id uuid,
  p_user_id uuid,
  p_prompt text default null
)
returns public.clip_takes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_clip public.clips;
  new_take public.clip_takes;
  next_take_number integer;
begin
  select clip.*
  into target_clip
  from public.clips as clip
  join public.projects as project on project.id = clip.project_id
  where clip.id = p_clip_id
    and project.user_id = p_user_id
  for update of clip;

  if target_clip.id is null then
    raise exception 'Clip not found';
  end if;

  if p_prompt is not null then
    if char_length(trim(p_prompt)) < 20 or char_length(p_prompt) > 30000 then
      raise exception 'Prompt must contain between 20 and 30000 characters';
    end if;
    update public.clips
    set prompt = p_prompt
    where id = target_clip.id;
  end if;

  select coalesce(max(take_number), 0) + 1
  into next_take_number
  from public.clip_takes
  where clip_id = target_clip.id;

  insert into public.clip_takes(
    project_id,
    clip_id,
    take_number,
    trim_end_seconds
  )
  values(
    target_clip.project_id,
    target_clip.id,
    next_take_number,
    target_clip.duration_seconds
  )
  returning * into new_take;

  insert into public.generation_jobs(
    project_id,
    kind,
    status,
    sequence,
    idempotency_key,
    payload,
    max_attempts
  )
  values(
    target_clip.project_id,
    'omni_take',
    'queued',
    1000 + target_clip.clip_number,
    target_clip.project_id || ':take:' || new_take.id,
    jsonb_build_object('take_id', new_take.id),
    3
  );

  update public.projects
  set state = 'generating'
  where id = target_clip.project_id;

  return new_take;
end;
$$;

-- Approval creates clips, first takes, and generation jobs in one transaction.
-- Repeating the request is safe because existing takes/jobs are reused.
create or replace function public.approve_project_generation(
  p_project_id uuid,
  p_user_id uuid,
  p_prompts jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_project public.projects;
  plan_clip jsonb;
  current_clip public.clips;
  current_take public.clip_takes;
  approved_prompt text;
  clip_count integer;
begin
  if jsonb_typeof(p_prompts) <> 'object' then
    raise exception 'Prompts must be a JSON object';
  end if;

  select *
  into target_project
  from public.projects
  where id = p_project_id
    and user_id = p_user_id
  for update;

  if target_project.id is null then
    raise exception 'Project not found';
  end if;

  if target_project.mode <> 'edit_video'
    and target_project.prompt_plan is null
  then
    raise exception 'Prompt plan is not ready';
  end if;

  select count(*)
  into clip_count
  from public.clips
  where project_id = target_project.id;

  if clip_count > 0 then
    for current_clip in
      select *
      from public.clips
      where project_id = target_project.id
      order by clip_number
    loop
      approved_prompt := p_prompts ->> current_clip.id::text;
      if approved_prompt is not null then
        if char_length(trim(approved_prompt)) < 20
          or char_length(approved_prompt) > 30000
        then
          raise exception 'Every prompt must contain between 20 and 30000 characters';
        end if;
        update public.clips
        set prompt = approved_prompt
        where id = current_clip.id;
      end if;

      for current_take in
        select *
        from public.clip_takes
        where clip_id = current_clip.id
        order by take_number
      loop
        insert into public.generation_jobs(
          project_id,
          kind,
          status,
          sequence,
          idempotency_key,
          payload,
          max_attempts
        )
        values(
          target_project.id,
          'omni_take',
          'queued',
          1000 + current_clip.clip_number,
          target_project.id || ':take:' || current_take.id,
          jsonb_build_object('take_id', current_take.id),
          3
        )
        on conflict(idempotency_key) do nothing;
      end loop;
    end loop;
  else
    if jsonb_typeof(target_project.prompt_plan -> 'clips') <> 'array' then
      raise exception 'Prompt plan has no clips';
    end if;

    for plan_clip in
      select value
      from jsonb_array_elements(target_project.prompt_plan -> 'clips')
    loop
      approved_prompt := coalesce(
        p_prompts ->> (plan_clip ->> 'clip_number'),
        plan_clip ->> 'prompt'
      );
      if char_length(trim(approved_prompt)) < 20
        or char_length(approved_prompt) > 30000
      then
        raise exception 'Every prompt must contain between 20 and 30000 characters';
      end if;

      insert into public.clips(
        project_id,
        clip_number,
        duration_seconds,
        spoken_line,
        prompt
      )
      values(
        target_project.id,
        (plan_clip ->> 'clip_number')::integer,
        (plan_clip ->> 'duration_seconds')::integer,
        plan_clip ->> 'spoken_line',
        approved_prompt
      )
      returning * into current_clip;

      insert into public.clip_takes(
        project_id,
        clip_id,
        take_number,
        trim_end_seconds
      )
      values(
        target_project.id,
        current_clip.id,
        1,
        current_clip.duration_seconds
      )
      returning * into current_take;

      insert into public.generation_jobs(
        project_id,
        kind,
        status,
        sequence,
        idempotency_key,
        payload,
        max_attempts
      )
      values(
        target_project.id,
        'omni_take',
        'queued',
        1000 + current_clip.clip_number,
        target_project.id || ':take:' || current_take.id,
        jsonb_build_object('take_id', current_take.id),
        3
      );

      clip_count := clip_count + 1;
    end loop;
  end if;

  update public.projects
  set
    prompt_approved_at = now(),
    state = 'generating'
  where id = target_project.id;

  return clip_count;
end;
$$;

-- Creates edit-mode clips and takes atomically after the browser has uploaded
-- every source segment. Repeating the request returns the existing document.
create or replace function public.configure_edit_project(
  p_project_id uuid,
  p_user_id uuid,
  p_segments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_project public.projects;
  segment jsonb;
  current_clip public.clips;
  omni_count integer := 0;
  raw_count integer := 0;
  total_duration numeric := 0;
begin
  if jsonb_typeof(p_segments) <> 'array'
    or jsonb_array_length(p_segments) < 1
    or jsonb_array_length(p_segments) > 100
  then
    raise exception 'A project requires between 1 and 100 segments';
  end if;

  select *
  into target_project
  from public.projects
  where id = p_project_id
    and user_id = p_user_id
  for update;

  if target_project.id is null then
    raise exception 'Project not found';
  end if;
  if target_project.mode <> 'edit_video' then
    raise exception 'Project is not in edit-video mode';
  end if;

  if exists (
    select 1 from public.clips where project_id = target_project.id
  ) then
    select
      count(*) filter (
        where exists (
          select 1 from public.clip_takes take where take.clip_id = clip.id
        )
      ),
      count(*) filter (
        where not exists (
          select 1 from public.clip_takes take where take.clip_id = clip.id
        )
      )
    into omni_count, raw_count
    from public.clips clip
    where clip.project_id = target_project.id;

    return jsonb_build_object(
      'clip_count', omni_count,
      'raw_append_count', raw_count
    );
  end if;

  for segment in
    select value from jsonb_array_elements(p_segments)
  loop
    if not exists (
      select 1
      from public.project_assets
      where project_id = target_project.id
        and owner_id = p_user_id
        and role = 'source_video_chunk'
        and storage_path = segment ->> 'storage_path'
    ) then
      raise exception 'A source segment is not registered to this project';
    end if;

    total_duration := total_duration + case
      when (segment ->> 'omni_duration')::integer > 0
        then (segment ->> 'omni_duration')::integer
      else greatest(0, (segment ->> 'source_duration_seconds')::numeric)
    end;

    if (segment ->> 'omni_duration')::integer > 0 then
      insert into public.clips(
        project_id,
        clip_number,
        duration_seconds,
        spoken_line,
        prompt,
        source_chunk_path
      )
      values(
        target_project.id,
        (segment ->> 'chunk_number')::integer,
        (segment ->> 'omni_duration')::integer,
        segment ->> 'spoken_line',
        segment ->> 'prompt',
        segment ->> 'storage_path'
      )
      returning * into current_clip;

      insert into public.clip_takes(
        project_id,
        clip_id,
        take_number,
        trim_end_seconds
      )
      values(
        target_project.id,
        current_clip.id,
        1,
        current_clip.duration_seconds
      );
      omni_count := omni_count + 1;
    elsif coalesce((segment ->> 'append_raw')::boolean, false) then
      insert into public.clips(
        project_id,
        clip_number,
        duration_seconds,
        spoken_line,
        prompt,
        source_chunk_path
      )
      values(
        target_project.id,
        (segment ->> 'chunk_number')::integer,
        greatest(1, ceil((segment ->> 'source_duration_seconds')::numeric)::integer),
        segment ->> 'spoken_line',
        segment ->> 'prompt',
        segment ->> 'storage_path'
      );
      raw_count := raw_count + 1;
    else
      raise exception 'Every segment must be processed by Omni or appended raw';
    end if;
  end loop;

  update public.projects
  set
    state = 'review',
    target_duration_seconds = greatest(4, round(total_duration)::integer)
  where id = target_project.id;

  return jsonb_build_object(
    'clip_count', omni_count,
    'raw_append_count', raw_count
  );
end;
$$;

-- Creates the canonical timeline exactly once and backfills its initial items.
-- An advisory transaction lock makes concurrent studio loads safe.
create or replace function public.ensure_project_timeline(
  p_project_id uuid,
  p_fps integer default 25
)
returns public.timelines
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  project_timeline public.timelines;
begin
  if not exists (
    select 1 from public.projects where id = p_project_id
  ) then
    raise exception 'Project not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));

  select *
  into project_timeline
  from public.timelines
  where project_id = p_project_id;

  if project_timeline.id is null then
    insert into public.timelines(project_id, fps)
    values(p_project_id, greatest(1, least(120, p_fps)))
    returning * into project_timeline;
  end if;

  if not exists (
    select 1
    from public.timeline_items
    where timeline_id = project_timeline.id
  ) then
    insert into public.timeline_items(
      timeline_id,
      clip_id,
      take_id,
      order_index,
      source_in_frame,
      source_out_frame
    )
    select
      project_timeline.id,
      clip.id,
      chosen_take.id,
      (row_number() over(order by clip.clip_number) - 1)::integer,
      greatest(
        0,
        round(coalesce(chosen_take.trim_start_seconds, 0) * project_timeline.fps)::integer
      ),
      greatest(
        greatest(
          0,
          round(
            coalesce(chosen_take.trim_start_seconds, 0)
            * project_timeline.fps
          )::integer
        ) + 1,
        round(
          coalesce(chosen_take.trim_end_seconds, clip.duration_seconds)
          * project_timeline.fps
        )::integer
      )
    from public.clips clip
    left join lateral (
      select take.*
      from public.clip_takes take
      where take.clip_id = clip.id
      order by
        (take.selected and take.status = 'completed') desc,
        (take.status = 'completed') desc,
        take.take_number
      limit 1
    ) chosen_take on true
    where clip.project_id = p_project_id
    order by clip.clip_number;
  end if;

  return project_timeline;
end;
$$;

-- Keeps operational logs bounded. Project/job records remain available.
create or replace function public.cleanup_reelforge_operational_history()
returns void
language plpgsql
security definer
set search_path = public, cron, pg_temp
as $$
begin
  delete from public.job_events
  where created_at < now() - interval '90 days';

  delete from cron.job_run_details
  where end_time < now() - interval '14 days';
end;
$$;

revoke all on function public.claim_next_generation_job(integer) from public, anon, authenticated;
revoke all on function public.quarantine_stale_submissions(integer) from public, anon, authenticated;
revoke all on function public.select_clip_take(uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_regeneration_take(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.approve_project_generation(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.configure_edit_project(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ensure_project_timeline(uuid, integer) from public, anon, authenticated;
revoke all on function public.cleanup_reelforge_operational_history() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

grant execute on function public.claim_next_generation_job(integer) to service_role;
grant execute on function public.quarantine_stale_submissions(integer) to service_role;
grant execute on function public.select_clip_take(uuid, uuid) to service_role;
grant execute on function public.create_regeneration_take(uuid, uuid, text) to service_role;
grant execute on function public.approve_project_generation(uuid, uuid, jsonb) to service_role;
grant execute on function public.configure_edit_project(uuid, uuid, jsonb) to service_role;
grant execute on function public.ensure_project_timeline(uuid, integer) to service_role;
