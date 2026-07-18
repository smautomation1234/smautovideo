-- ReelForge Omni v2: persistent, frame-accurate timeline editor.
-- Run after schema.sql and migration-edit-video.sql.

create table if not exists public.timelines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects(id) on delete cascade,
  fps integer not null default 25 check (fps between 1 and 120),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.timeline_items (
  id uuid primary key default gen_random_uuid(),
  timeline_id uuid not null references public.timelines(id) on delete cascade,
  clip_id uuid not null references public.clips(id) on delete cascade,
  take_id uuid references public.clip_takes(id) on delete set null,
  order_index integer not null check (order_index >= 0),
  source_in_frame integer not null default 0 check (source_in_frame >= 0),
  source_out_frame integer not null check (source_out_frame > source_in_frame),
  volume numeric(4,3) not null default 1 check (volume between 0 and 1),
  muted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(timeline_id, order_index)
);

create index if not exists timeline_items_timeline_order
  on public.timeline_items(timeline_id, order_index);

drop trigger if exists timelines_updated_at on public.timelines;
create trigger timelines_updated_at
  before update on public.timelines
  for each row execute function public.set_updated_at();

drop trigger if exists timeline_items_updated_at on public.timeline_items;
create trigger timeline_items_updated_at
  before update on public.timeline_items
  for each row execute function public.set_updated_at();

alter table public.timelines enable row level security;
alter table public.timeline_items enable row level security;

drop policy if exists "timelines own" on public.timelines;
create policy "timelines own" on public.timelines
  for select to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists "timeline items own" on public.timeline_items;
create policy "timeline items own" on public.timeline_items
  for select to authenticated
  using (
    exists (
      select 1
      from public.timelines t
      join public.projects p on p.id = t.project_id
      where t.id = timeline_id and p.user_id = auth.uid()
    )
  );

-- Atomic full-document save. Only the server service role may execute it.
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
set search_path = public
as $$
declare
  v_timeline public.timelines;
  v_item jsonb;
  v_index integer := 0;
  v_clip_project uuid;
  v_take_clip uuid;
begin
  if not exists (
    select 1 from public.projects
    where id = p_project_id and user_id = p_user_id
  ) then
    raise exception 'Project not found';
  end if;

  select * into v_timeline
  from public.timelines
  where project_id = p_project_id
  for update;

  if v_timeline.id is null then
    insert into public.timelines(project_id, fps)
    values(p_project_id, p_fps)
    returning * into v_timeline;
  elsif v_timeline.version <> p_expected_version then
    raise exception 'TIMELINE_VERSION_CONFLICT';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'Invalid timeline document';
  end if;

  delete from public.timeline_items where timeline_id = v_timeline.id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select project_id into v_clip_project
    from public.clips
    where id = (v_item->>'clip_id')::uuid;

    if v_clip_project is distinct from p_project_id then
      raise exception 'Timeline item clip does not belong to project';
    end if;

    if nullif(v_item->>'take_id', '') is not null then
      select clip_id into v_take_clip
      from public.clip_takes
      where id = (v_item->>'take_id')::uuid;
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

  update public.timelines
  set fps = p_fps, version = version + 1
  where id = v_timeline.id
  returning version into new_version;

  timeline_id := v_timeline.id;
  return next;
end;
$$;

revoke all on function public.save_timeline_document(uuid, uuid, integer, integer, jsonb) from public;
revoke all on function public.save_timeline_document(uuid, uuid, integer, integer, jsonb) from anon;
revoke all on function public.save_timeline_document(uuid, uuid, integer, integer, jsonb) from authenticated;
grant execute on function public.save_timeline_document(uuid, uuid, integer, integer, jsonb) to service_role;

-- Import timelines that were edited through the zero-migration JSON fallback.
-- This preserves edits made before this normalized migration is installed.
insert into public.timelines(id, project_id, fps, version)
select
  (p.prompt_plan->'editor_timeline'->>'id')::uuid,
  p.id,
  case
    when (p.prompt_plan->'editor_timeline'->>'fps') ~ '^[0-9]+$'
      then least(120, greatest(1, (p.prompt_plan->'editor_timeline'->>'fps')::integer))
    else 25
  end,
  case
    when (p.prompt_plan->'editor_timeline'->>'version') ~ '^[0-9]+$'
      then greatest(1, (p.prompt_plan->'editor_timeline'->>'version')::integer)
    else 1
  end
from public.projects p
where jsonb_typeof(p.prompt_plan->'editor_timeline') = 'object'
  and (p.prompt_plan->'editor_timeline'->>'id')
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
on conflict(project_id) do nothing;

-- Backfill one 25 fps timeline per existing generated project. Re-running is safe.
insert into public.timelines(project_id, fps)
select p.id, 25
from public.projects p
where exists (select 1 from public.clips c where c.project_id = p.id)
on conflict(project_id) do nothing;

insert into public.timeline_items(
  id,
  timeline_id,
  clip_id,
  take_id,
  order_index,
  source_in_frame,
  source_out_frame,
  volume,
  muted,
  created_at,
  updated_at
)
select
  (entry.item->>'id')::uuid,
  t.id,
  c.id,
  ct.id,
  (entry.ordinality - 1)::integer,
  (entry.item->>'source_in_frame')::integer,
  (entry.item->>'source_out_frame')::integer,
  case
    when (entry.item->>'volume') ~ '^[0-9]+([.][0-9]+)?$'
      then least(1, greatest(0, (entry.item->>'volume')::numeric))
    else 1
  end,
  coalesce((entry.item->>'muted')::boolean, false),
  now(),
  now()
from public.projects p
join public.timelines t on t.project_id = p.id
cross join lateral jsonb_array_elements(
  case
    when jsonb_typeof(p.prompt_plan->'editor_timeline'->'items') = 'array'
      then p.prompt_plan->'editor_timeline'->'items'
    else '[]'::jsonb
  end
) with ordinality as entry(item, ordinality)
join public.clips c
  on c.id = case
    when (entry.item->>'clip_id')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (entry.item->>'clip_id')::uuid
    else null
  end
  and c.project_id = p.id
left join public.clip_takes ct
  on ct.id = case
    when (entry.item->>'take_id')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (entry.item->>'take_id')::uuid
    else null
  end
  and ct.clip_id = c.id
where not exists (
    select 1 from public.timeline_items existing where existing.timeline_id = t.id
  )
  and (entry.item->>'id')
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and (entry.item->>'source_in_frame') ~ '^[0-9]+$'
  and (entry.item->>'source_out_frame') ~ '^[0-9]+$'
  and (entry.item->>'source_out_frame')::integer
    > (entry.item->>'source_in_frame')::integer
  and (
    nullif(entry.item->>'take_id', '') is null
    or ct.id is not null
  )
on conflict(id) do nothing;

-- Projects without an imported JSON document get one item per existing clip.
insert into public.timeline_items(
  timeline_id,
  clip_id,
  take_id,
  order_index,
  source_in_frame,
  source_out_frame
)
select
  t.id,
  c.id,
  chosen_take.id,
  (row_number() over(partition by c.project_id order by c.clip_number) - 1)::integer,
  greatest(0, round(coalesce(chosen_take.trim_start_seconds, 0) * t.fps)::integer),
  greatest(
    1,
    round(coalesce(chosen_take.trim_end_seconds, c.duration_seconds) * t.fps)::integer
  )
from public.clips c
join public.timelines t on t.project_id = c.project_id
left join lateral (
  select ct.*
  from public.clip_takes ct
  where ct.clip_id = c.id
  order by
    (ct.selected and ct.status = 'completed') desc,
    (ct.status = 'completed') desc,
    ct.take_number
  limit 1
) chosen_take on true
where not exists (
  select 1 from public.timeline_items ti where ti.timeline_id = t.id
)
order by c.project_id, c.clip_number;
