-- Fix the save function's output parameter `timeline_id` colliding with the
-- timeline_items.timeline_id column in PL/pgSQL name resolution.
-- Re-running this migration is safe.

create or replace function public.save_timeline_document(
  p_project_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_fps integer,
  p_items jsonb
)
returns table(timeline_id uuid, new_version integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $timeline_save_function$
declare
  v_timeline public.timelines;
  v_item jsonb;
  v_index integer := 0;
  v_clip_project uuid;
  v_take_clip uuid;
begin
  if not exists (
    select 1
    from public.projects as owned_project
    where owned_project.id = p_project_id
      and owned_project.user_id = p_user_id
  ) then
    raise exception 'Project not found';
  end if;

  select project_timeline.*
  into v_timeline
  from public.timelines as project_timeline
  where project_timeline.project_id = p_project_id
  for update;

  if v_timeline.id is null then
    insert into public.timelines(project_id, fps)
    values(p_project_id, p_fps)
    returning * into v_timeline;
  elsif v_timeline.version <> p_expected_version then
    raise exception 'TIMELINE_VERSION_CONFLICT';
  end if;

  if jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) > 500
  then
    raise exception 'Invalid timeline document';
  end if;

  delete from public.timeline_items as saved_item
  where saved_item.timeline_id = v_timeline.id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select project_clip.project_id
    into v_clip_project
    from public.clips as project_clip
    where project_clip.id = (v_item->>'clip_id')::uuid;

    if v_clip_project is distinct from p_project_id then
      raise exception 'Timeline item clip does not belong to project';
    end if;

    if nullif(v_item->>'take_id', '') is not null then
      select clip_take.clip_id
      into v_take_clip
      from public.clip_takes as clip_take
      where clip_take.id = (v_item->>'take_id')::uuid;

      if v_take_clip is distinct from (v_item->>'clip_id')::uuid then
        raise exception 'Timeline item take does not belong to clip';
      end if;
    end if;

    insert into public.timeline_items(
      id,
      timeline_id,
      clip_id,
      take_id,
      order_index,
      source_in_frame,
      source_out_frame,
      volume,
      muted
    ) values (
      coalesce(nullif(v_item->>'id', '')::uuid, gen_random_uuid()),
      v_timeline.id,
      (v_item->>'clip_id')::uuid,
      nullif(v_item->>'take_id', '')::uuid,
      v_index,
      greatest(0, (v_item->>'source_in_frame')::integer),
      (v_item->>'source_out_frame')::integer,
      least(1, greatest(0, coalesce((v_item->>'volume')::numeric, 1))),
      coalesce((v_item->>'muted')::boolean, false)
    );
    v_index := v_index + 1;
  end loop;

  update public.timelines as saved_timeline
  set
    fps = p_fps,
    version = saved_timeline.version + 1
  where saved_timeline.id = v_timeline.id
  returning saved_timeline.version into new_version;

  timeline_id := v_timeline.id;
  return next;
end;
$timeline_save_function$;

revoke all on function public.save_timeline_document(
  uuid,
  uuid,
  integer,
  integer,
  jsonb
) from public, anon, authenticated;

grant execute on function public.save_timeline_document(
  uuid,
  uuid,
  integer,
  integer,
  jsonb
) to service_role;
