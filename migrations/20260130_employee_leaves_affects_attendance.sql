BEGIN;

ALTER TABLE public.employee_leaves
  ADD COLUMN IF NOT EXISTS affects_attendance boolean NOT NULL DEFAULT true;

UPDATE public.employee_leaves
SET affects_attendance = true
WHERE affects_attendance IS NULL;

COMMIT;
