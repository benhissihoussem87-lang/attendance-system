BEGIN;

CREATE TABLE IF NOT EXISTS public.companies (
    company_id text PRIMARY KEY,
    display_name text NOT NULL,
    country text NULL,
    timezone text NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.companies (company_id, display_name)
VALUES ('DEFAULT', 'DEFAULT')
ON CONFLICT (company_id) DO NOTHING;

DO $$
DECLARE
  tz_col text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'company_config'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='company_config' AND column_name='company_timezone'
    ) THEN
      tz_col := 'company_timezone';
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='company_config' AND column_name='timezone'
    ) THEN
      tz_col := 'timezone';
    ELSE
      tz_col := NULL;
    END IF;

    IF tz_col IS NULL THEN
      EXECUTE $q$
        INSERT INTO public.companies (company_id, display_name, timezone)
        SELECT DISTINCT company_id, company_id, 'Africa/Tunis'
        FROM public.company_config
        ON CONFLICT (company_id) DO UPDATE
          SET timezone = COALESCE(public.companies.timezone, EXCLUDED.timezone),
              updated_at = now()
      $q$;
    ELSE
      EXECUTE format($q$
        INSERT INTO public.companies (company_id, display_name, timezone)
        SELECT DISTINCT company_id, company_id, %I
        FROM public.company_config
        ON CONFLICT (company_id) DO UPDATE
          SET timezone = COALESCE(public.companies.timezone, EXCLUDED.timezone),
              updated_at = now()
      $q$, tz_col);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'company_working_days'
  ) THEN
    INSERT INTO public.companies (company_id, display_name)
    SELECT DISTINCT company_id, company_id
    FROM public.company_working_days
    ON CONFLICT (company_id) DO NOTHING;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'policy_profiles'
  ) THEN
    INSERT INTO public.companies (company_id, display_name)
    SELECT DISTINCT company_id, company_id
    FROM public.policy_profiles
    ON CONFLICT (company_id) DO NOTHING;
  END IF;
END $$;

COMMIT;
