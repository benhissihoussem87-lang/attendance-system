BEGIN;

ALTER TABLE public.device_events
  ADD COLUMN IF NOT EXISTS company_id text DEFAULT 'DEFAULT';
UPDATE public.device_events
SET company_id = 'DEFAULT'
WHERE company_id IS NULL;
ALTER TABLE public.device_events
  ALTER COLUMN company_id SET NOT NULL;

ALTER TABLE public.attendance_days
  ADD COLUMN IF NOT EXISTS company_id text DEFAULT 'DEFAULT';
UPDATE public.attendance_days
SET company_id = 'DEFAULT'
WHERE company_id IS NULL;
ALTER TABLE public.attendance_days
  ALTER COLUMN company_id SET NOT NULL;

ALTER TABLE public.employee_leaves
  ADD COLUMN IF NOT EXISTS company_id text DEFAULT 'DEFAULT';
UPDATE public.employee_leaves
SET company_id = 'DEFAULT'
WHERE company_id IS NULL;
ALTER TABLE public.employee_leaves
  ALTER COLUMN company_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_events_company_id_fkey'
  ) THEN
    ALTER TABLE public.device_events
      ADD CONSTRAINT device_events_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES public.companies(company_id) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_days_company_id_fkey'
  ) THEN
    ALTER TABLE public.attendance_days
      ADD CONSTRAINT attendance_days_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES public.companies(company_id) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employee_leaves_company_id_fkey'
  ) THEN
    ALTER TABLE public.employee_leaves
      ADD CONSTRAINT employee_leaves_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES public.companies(company_id) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_days_person_id_work_date_key'
  ) THEN
    ALTER TABLE public.attendance_days
      DROP CONSTRAINT attendance_days_person_id_work_date_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_days_company_person_date_uk'
  ) THEN
    ALTER TABLE public.attendance_days
      ADD CONSTRAINT attendance_days_company_person_date_uk UNIQUE (company_id, person_id, work_date);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ux_device_events_dedup'
  ) THEN
    ALTER TABLE public.device_events
      DROP CONSTRAINT ux_device_events_dedup;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_device_events_dedup'
  ) THEN
    DROP INDEX public.ux_device_events_dedup;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_events_dedup_company_uk'
  ) THEN
    ALTER TABLE public.device_events
      ADD CONSTRAINT device_events_dedup_company_uk
      UNIQUE (company_id, person_id, event_time_utc, direction, device_uid);
  END IF;
END $$;

COMMIT;
