-- Run this file once in Supabase SQL Editor AFTER deploying the app to Vercel
-- and after applying every file in supabase/migrations in filename order.
--
-- Before running, replace exactly these two placeholders:
--   https://YOUR-VERCEL-DOMAIN
--   REPLACE_WITH_THE_SAME_CRON_SECRET_USED_IN_VERCEL

do $$
declare
  app_url constant text := 'https://YOUR-VERCEL-DOMAIN';
  cron_secret constant text := 'REPLACE_WITH_THE_SAME_CRON_SECRET_USED_IN_VERCEL';
  existing_id uuid;
begin
  if app_url like '%YOUR-VERCEL-DOMAIN%'
    or cron_secret like 'REPLACE_WITH_%'
    or length(cron_secret) < 32
  then
    raise exception 'Replace the app URL and use a CRON_SECRET of at least 32 characters before running this script.';
  end if;

  select id into existing_id
  from vault.decrypted_secrets
  where name = 'reelforge_app_url';

  if existing_id is null then
    perform vault.create_secret(
      rtrim(app_url, '/'),
      'reelforge_app_url',
      'Production URL used by the ReelForge job dispatcher'
    );
  else
    perform vault.update_secret(
      existing_id,
      rtrim(app_url, '/'),
      'reelforge_app_url',
      'Production URL used by the ReelForge job dispatcher'
    );
  end if;

  select id into existing_id
  from vault.decrypted_secrets
  where name = 'reelforge_cron_secret';

  if existing_id is null then
    perform vault.create_secret(
      cron_secret,
      'reelforge_cron_secret',
      'Shared authorization secret for the ReelForge dispatcher'
    );
  else
    perform vault.update_secret(
      existing_id,
      cron_secret,
      'reelforge_cron_secret',
      'Shared authorization secret for the ReelForge dispatcher'
    );
  end if;
end;
$$;

select cron.unschedule(jobid)
from cron.job
where jobname in ('reelforge-dispatch', 'reelforge-maintenance');

select cron.schedule(
  'reelforge-dispatch',
  '15 seconds',
  $cron$
    select net.http_post(
      url := (
        select rtrim(decrypted_secret, '/')
        from vault.decrypted_secrets
        where name = 'reelforge_app_url'
      ) || '/api/cron/dispatch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'reelforge_cron_secret'
        )
      ),
      body := jsonb_build_object(
        'source', 'supabase-cron',
        'scheduled_at', now()
      ),
      timeout_milliseconds := 300000
    ) as request_id;
  $cron$
);

select cron.schedule(
  'reelforge-maintenance',
  '17 3 * * *',
  'select public.cleanup_reelforge_operational_history();'
);

-- Verification: both rows should be active.
select jobid, jobname, schedule, active
from cron.job
where jobname in ('reelforge-dispatch', 'reelforge-maintenance')
order by jobname;
