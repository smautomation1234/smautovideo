# ReelForge Omni

ReelForge creates short-form videos in two modes:

- **From Scratch** — Gemini 2.5 Flash creates a fact-checked script and clip
  prompts, then Gemini Omni Flash generates each clip from one presenter image.
- **Edit Video** — the browser divides an uploaded video into frame-accurate
  segments, then Gemini Omni Flash edits each segment while preserving its
  original timing and audio.

Both modes finish in the same persistent 24 FPS timeline editor, matching
Gemini Omni Flash's native output rate.

## Architecture

```text
Browser (Next.js)
  ├─ authenticated project and editor UI
  ├─ local OPFS/RAM media cache
  ├─ 24 FPS video segmentation
  └─ local timeline preview and MP4 export
          │
          ▼
Supabase
  ├─ Auth and row-level security
  ├─ Postgres project, job, take, and timeline state
  ├─ private Storage bucket for source/generated media
  └─ Cron invokes the production dispatcher every 15 seconds
          │
          ▼
Vercel / Next.js dispatcher
  ├─ atomically claims one database job
  ├─ calls Gemini or Gemini Omni Flash
  ├─ polls background Omni interactions
  └─ stores completed video in Supabase Storage
```

The database is the source of truth. A browser may close, a deployment may
restart, or two scheduler requests may overlap without duplicating the same
claimed job.

## Local setup

Requirements:

- Node.js 22
- A Supabase project
- A Gemini API key
- A Google Cloud project and service account with Gemini Omni Flash access

Copy `.env.example` to `.env` and fill every required value.

Install and start:

```bash
npm install
npm run dev
```

`npm run dev` now starts both Next.js and the local job worker. Use
`npm run dev:web` only when you intentionally want the web application without
background job processing.

Quality checks:

```bash
npm run check
```

## Supabase database setup

For a new Supabase project, run every SQL file below in filename order:

1. `supabase/migrations/202607180001_initial_schema.sql`
2. `supabase/migrations/202607180002_edit_video.sql`
3. `supabase/migrations/202607180003_timeline_editor.sql`
4. `supabase/migrations/202607180004_production_hardening.sql`
5. `supabase/migrations/202607180005_editor_reliability.sql`
6. `supabase/migrations/202607180006_native_24_fps.sql`
7. `supabase/migrations/202607180007_timeline_save_ambiguity.sql`

For a database that already had the old schema and both old migration files,
run:

```text
supabase/migrations/202607180004_production_hardening.sql
supabase/migrations/202607180005_editor_reliability.sql
supabase/migrations/202607180006_native_24_fps.sql
supabase/migrations/202607180007_timeline_save_ambiguity.sql
```

The fourth migration enables `pg_cron`, `pg_net`, and Vault; hardens privileged
functions; and adds atomic operations for approval, take selection,
regeneration, edit setup, and timeline creation.

The fifth migration adds stable generation timestamps and structured provider
errors used by the live Table View progress and prompt-level error messages.

The sixth migration converts saved timeline frame boundaries from their old
rate to 24 FPS while preserving playback times, updates new timeline defaults,
and enforces the canonical native rate.

The seventh migration qualifies timeline save queries to prevent PostgreSQL
from confusing the function's `timeline_id` output with the table column.

## Production deployment

### 1. Add Vercel environment variables

Add all variables from `.env.example` to the Vercel project. Prefer Supabase's
current `sb_secret_...` key in `SUPABASE_SECRET_KEY`; the legacy service-role
variable remains supported during migration. Generate a strong random
`CRON_SECRET` with at least 32 characters.

Never commit `.env`, service-account JSON, service-role/secret keys, or provider
responses to GitHub.

### 2. Deploy to Vercel

Connect the GitHub repository to Vercel and deploy normally. There is no Vercel
Cron entry in `vercel.json`; Supabase owns scheduling.

### 3. Configure Supabase Cron

Open `supabase/configure-cron.sql` and replace:

- `https://YOUR-VERCEL-DOMAIN` with the production Vercel/custom domain.
- `REPLACE_WITH_THE_SAME_CRON_SECRET_USED_IN_VERCEL` with the exact
  `CRON_SECRET` value from Vercel.

Run the edited file once in Supabase SQL Editor. It stores both values in
Supabase Vault, schedules the dispatcher every 15 seconds, and schedules daily
operational-log cleanup.

Verify scheduler runs:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname in ('reelforge-dispatch', 'reelforge-maintenance');

select status, start_time, end_time, return_message
from cron.job_run_details
order by start_time desc
limit 20;
```

Verify HTTP responses from the Vercel dispatcher:

```sql
select id, status_code, timed_out, error_msg, created
from net._http_response
order by created desc
limit 20;
```

## Timeline editor behavior

- Media is downloaded once to local Origin Private File System storage when
  supported, with an in-memory Blob fallback.
- Playback, trim, thumbnails, splitting, duplication, and export use local
  media rather than repeatedly streaming from Supabase.
- Timeline positions are stored as integer frames at 24 FPS.
- `Ctrl/Cmd+C` copies the selected timeline item.
- `Ctrl/Cmd+V` inserts an independent copy immediately after the selected item.
- `Ctrl/Cmd+K` splits at the playhead.
- Arrow keys move by exactly one frame.
- Delete performs a ripple delete.
- Undo and redo use `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z`.
- At high zoom, every individual frame receives a visible grid division.
- MP4 export validates that every expected frame was decoded before completing.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the local web server and worker |
| `npm run dev:web` | Start only Next.js |
| `npm run worker` | Start only the local worker |
| `npm run lint` | Run non-interactive ESLint |
| `npm run typecheck` | Run strict TypeScript checking |
| `npm run test` | Run timeline-domain tests |
| `npm run build` | Create the production build |
| `npm run check` | Run lint, typecheck, tests, and build |

## Repository layout

```text
src/app/                  Next.js pages and API routes
src/components/           User-facing forms and studio shell
src/features/timeline/    Timeline domain operations
src/features/video-import Browser video segmentation and encoding
src/lib/pipeline/         Background generation pipeline
src/lib/supabase/         Supabase clients
supabase/migrations/      Ordered, repeatable database migrations
supabase/configure-cron.sql
scripts/run-worker.ts     Local-only continuous worker
tests/                    Pure domain tests
```

## Security note

This workspace previously contained an unignored `.env`. If that file was ever
uploaded to GitHub or shared, rotate the Supabase server secret/service-role
key, Gemini key, Google service-account credentials, and `CRON_SECRET` before
deploying.
