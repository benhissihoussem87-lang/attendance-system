BEGIN;

DO $$
DECLARE
  first_legacy text;
  last_legacy text;
BEGIN
  IF to_regclass('public.attendance_days') IS NOT NULL THEN
    ALTER TABLE public.attendance_days
      ADD COLUMN IF NOT EXISTS first_in_utc timestamptz NULL,
      ADD COLUMN IF NOT EXISTS last_out_utc timestamptz NULL;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'attendance_days' AND column_name = 'first_in'
    ) THEN
      first_legacy := 'first_in';
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'attendance_days' AND column_name = 'first_in_time'
    ) THEN
      first_legacy := 'first_in_time';
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'attendance_days' AND column_name = 'first_in_ts'
    ) THEN
      first_legacy := 'first_in_ts';
    ELSE
      first_legacy := NULL;
    END IF;

    IF first_legacy IS NOT NULL THEN
      EXECUTE format(
        'UPDATE public.attendance_days SET first_in_utc = %I WHERE first_in_utc IS NULL AND %I IS NOT NULL',
        first_legacy,
        first_legacy
      );
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'attendance_days' AND column_name = 'last_out'
    ) THEN
      last_legacy := 'last_out';
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'attendance_days' AND column_name = 'last_out_time'
    ) THEN
      last_legacy := 'last_out_time';
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'attendance_days' AND column_name = 'last_out_ts'
    ) THEN
      last_legacy := 'last_out_ts';
    ELSE
      last_legacy := NULL;
    END IF;

    IF last_legacy IS NOT NULL THEN
      EXECUTE format(
        'UPDATE public.attendance_days SET last_out_utc = %I WHERE last_out_utc IS NULL AND %I IS NOT NULL',
        last_legacy,
        last_legacy
      );
    END IF;
  END IF;
END $$;

COMMIT;
