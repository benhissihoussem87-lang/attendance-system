BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.policy_profiles (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  company_id text NOT NULL,
  name text NOT NULL,
  version integer NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.policy_profiles
  ADD COLUMN IF NOT EXISTS company_id text,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS version integer,
  ADD COLUMN IF NOT EXISTS params jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

UPDATE public.policy_profiles
SET company_id = COALESCE(company_id, 'DEFAULT')
WHERE company_id IS NULL;

UPDATE public.policy_profiles
SET params = '{}'::jsonb
WHERE params IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'policy_profiles_company_name_version_uk'
  ) THEN
    ALTER TABLE public.policy_profiles
      ADD CONSTRAINT policy_profiles_company_name_version_uk UNIQUE (company_id, name, version);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_policy_profiles_company_version'
  ) THEN
    CREATE INDEX idx_policy_profiles_company_version ON public.policy_profiles(company_id, version DESC);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.attendance_day_resolutions (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  company_id text NOT NULL DEFAULT 'DEFAULT',
  attendance_day_id uuid NOT NULL,
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  effective_status text NOT NULL,
  override jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason_code text NULL,
  note text NULL,
  is_active boolean NOT NULL DEFAULT true
);

ALTER TABLE public.attendance_day_resolutions
  ADD COLUMN IF NOT EXISTS company_id text,
  ADD COLUMN IF NOT EXISTS attendance_day_id uuid,
  ADD COLUMN IF NOT EXISTS decided_by text,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS action text,
  ADD COLUMN IF NOT EXISTS effective_status text,
  ADD COLUMN IF NOT EXISTS override jsonb,
  ADD COLUMN IF NOT EXISTS reason_code text,
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS is_active boolean;

UPDATE public.attendance_day_resolutions
SET company_id = COALESCE(company_id, 'DEFAULT')
WHERE company_id IS NULL;

UPDATE public.attendance_day_resolutions
SET override = '{}'::jsonb
WHERE override IS NULL;

UPDATE public.attendance_day_resolutions
SET decided_at = now()
WHERE decided_at IS NULL;

UPDATE public.attendance_day_resolutions
SET is_active = true
WHERE is_active IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'attendance_day_resolutions_attendance_day_id_fkey'
  ) THEN
    ALTER TABLE public.attendance_day_resolutions
      ADD CONSTRAINT attendance_day_resolutions_attendance_day_id_fkey
      FOREIGN KEY (attendance_day_id) REFERENCES public.attendance_days(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ux_attendance_day_resolutions_one_active'
  ) THEN
    CREATE UNIQUE INDEX ux_attendance_day_resolutions_one_active
      ON public.attendance_day_resolutions(attendance_day_id)
      WHERE is_active = true;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_attendance_day_resolutions_company_active'
  ) THEN
    CREATE INDEX idx_attendance_day_resolutions_company_active
      ON public.attendance_day_resolutions(company_id, is_active, decided_at DESC);
  END IF;
END $$;

ALTER TABLE public.attendance_days
  ADD COLUMN IF NOT EXISTS flags text[] DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS audit jsonb DEFAULT '{}'::jsonb;

COMMIT;
