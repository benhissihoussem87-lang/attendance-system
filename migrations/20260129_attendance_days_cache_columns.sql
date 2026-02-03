BEGIN;

DO $$
BEGIN
  IF to_regclass('public.attendance_days') IS NOT NULL THEN
    ALTER TABLE public.attendance_days
      ADD COLUMN IF NOT EXISTS first_in_utc timestamptz NULL,
      ADD COLUMN IF NOT EXISTS last_out_utc timestamptz NULL,
      ADD COLUMN IF NOT EXISTS worked_minutes integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS late_minutes integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS computed_at timestamptz DEFAULT now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.attendance_days') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'attendance_days'
         AND column_name = 'metrics'
     ) THEN
    UPDATE public.attendance_days
    SET
      first_in_utc = CASE
        WHEN first_in_utc IS NULL
          AND metrics ? 'first_in_utc'
          AND (metrics->>'first_in_utc') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        THEN (metrics->>'first_in_utc')::timestamptz
        ELSE first_in_utc
      END,
      last_out_utc = CASE
        WHEN last_out_utc IS NULL
          AND metrics ? 'last_out_utc'
          AND (metrics->>'last_out_utc') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        THEN (metrics->>'last_out_utc')::timestamptz
        ELSE last_out_utc
      END,
      worked_minutes = CASE
        WHEN worked_minutes = 0
          AND metrics ? 'worked_minutes'
          AND (metrics->>'worked_minutes') ~ '^[0-9]+$'
        THEN (metrics->>'worked_minutes')::int
        ELSE worked_minutes
      END,
      late_minutes = CASE
        WHEN late_minutes = 0
          AND metrics ? 'late_minutes'
          AND (metrics->>'late_minutes') ~ '^[0-9]+$'
        THEN (metrics->>'late_minutes')::int
        ELSE late_minutes
      END,
      explanation = CASE
        WHEN explanation = '{}'::jsonb
          AND metrics ? 'explanation'
        THEN metrics->'explanation'
        ELSE explanation
      END
    WHERE metrics IS NOT NULL;
  END IF;
END $$;

COMMIT;
