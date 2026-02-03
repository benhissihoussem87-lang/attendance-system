BEGIN;

DO $$
BEGIN
  IF to_regclass('public.policy_profiles') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='policy_profiles_company_id_name_version_key')
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='policy_profiles_company_name_version_uk') THEN
      ALTER TABLE public.policy_profiles
        DROP CONSTRAINT policy_profiles_company_id_name_version_key;
    ELSIF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='policy_profiles_company_id_name_version_key')
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='policy_profiles_company_name_version_uk') THEN
      ALTER TABLE public.policy_profiles
        DROP CONSTRAINT policy_profiles_company_id_name_version_key;
      ALTER TABLE public.policy_profiles
        ADD CONSTRAINT policy_profiles_company_name_version_uk UNIQUE (company_id, name, version);
    ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='policy_profiles_company_name_version_uk') THEN
      ALTER TABLE public.policy_profiles
        ADD CONSTRAINT policy_profiles_company_name_version_uk UNIQUE (company_id, name, version);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.attendance_day_resolutions') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ux_resolution_one_active')
       AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ux_attendance_day_resolutions_one_active') THEN
      DROP INDEX public.ux_resolution_one_active;
    ELSIF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ux_resolution_one_active')
       AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ux_attendance_day_resolutions_one_active') THEN
      DROP INDEX public.ux_resolution_one_active;
      CREATE UNIQUE INDEX ux_attendance_day_resolutions_one_active
        ON public.attendance_day_resolutions(attendance_day_id)
        WHERE is_active = true;
    ELSIF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ux_attendance_day_resolutions_one_active') THEN
      CREATE UNIQUE INDEX ux_attendance_day_resolutions_one_active
        ON public.attendance_day_resolutions(attendance_day_id)
        WHERE is_active = true;
    END IF;
  END IF;
END $$;

COMMIT;
