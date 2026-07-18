-- ReelForge Omni v2: edit-video mode.
-- Run this AFTER the base schema.sql has been applied.

-- 1. New enum for project mode
DO $$ BEGIN
  CREATE TYPE public.project_mode AS ENUM ('from_scratch', 'edit_video');
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Add mode column with backward-compatible default
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS mode public.project_mode NOT NULL DEFAULT 'from_scratch';

-- 3. Expand asset_role enum to support source video chunks
-- (ALTER TYPE ... ADD VALUE cannot run inside a transaction block in some PG versions,
--  so we guard with a DO block that catches the duplicate.)
DO $$ BEGIN
  ALTER TYPE public.asset_role ADD VALUE IF NOT EXISTS 'source_video_chunk';
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. Add source_chunk_path column to clips for edit_video mode
ALTER TABLE public.clips
  ADD COLUMN IF NOT EXISTS source_chunk_path TEXT;

-- 5. Make raw_post and target_duration_seconds nullable-safe for edit_video mode.
--    raw_post already has a min-length check so we supply a placeholder on insert.
--    No constraint changes needed — the app layer handles defaults.

-- 6. Loosen clips duration check constraint to allow arbitrary edit mode slice lengths
ALTER TABLE public.clips
  DROP CONSTRAINT IF EXISTS clips_duration_seconds_check;
ALTER TABLE public.clips
  ADD CONSTRAINT clips_duration_seconds_check CHECK (duration_seconds between 1 and 300);
