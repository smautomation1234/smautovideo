-- Gemini Omni Flash renders video at 24 FPS. Convert every existing timeline
-- to the canonical rate while preserving each saved trim boundary's time.
-- Re-running this migration is safe.

with converted_timelines as (
  select id, fps
  from public.timelines
  where fps <> 24
)
update public.timeline_items as item
set
  source_in_frame = greatest(
    0,
    round(item.source_in_frame * 24.0 / timeline.fps)::integer
  ),
  source_out_frame = greatest(
    round(item.source_in_frame * 24.0 / timeline.fps)::integer + 1,
    round(item.source_out_frame * 24.0 / timeline.fps)::integer
  )
from converted_timelines as timeline
where item.timeline_id = timeline.id;

update public.timelines
set
  fps = 24,
  version = version + 1
where fps <> 24;

alter table public.timelines
  alter column fps set default 24;

alter table public.timelines
  drop constraint if exists timelines_native_fps;

alter table public.timelines
  add constraint timelines_native_fps check (fps = 24) not valid;

alter table public.timelines
  validate constraint timelines_native_fps;

-- Keep the existing function signature for deployed callers, but make its
-- default and newly created timelines canonical 24 FPS.
create or replace function public.ensure_project_timeline(
  p_project_id uuid,
  p_fps integer default 24
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

  if p_fps <> 24 then
    raise exception 'ReelForge timelines must use the native 24 FPS rate';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));

  select *
  into project_timeline
  from public.timelines
  where project_id = p_project_id;

  if project_timeline.id is null then
    insert into public.timelines(project_id, fps)
    values(p_project_id, 24)
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
        round(coalesce(chosen_take.trim_start_seconds, 0) * 24)::integer
      ),
      greatest(
        greatest(
          0,
          round(coalesce(chosen_take.trim_start_seconds, 0) * 24)::integer
        ) + 1,
        round(
          coalesce(chosen_take.trim_end_seconds, clip.duration_seconds) * 24
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

revoke all on function public.ensure_project_timeline(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.ensure_project_timeline(uuid, integer)
  to service_role;
