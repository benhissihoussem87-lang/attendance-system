BEGIN;

DO $$
DECLARE
  has_timezone boolean;
  has_display_name boolean;
  has_updated_at boolean;
  cols text[] := ARRAY[]::text[];
  vals text[] := ARRAY[]::text[];
  updates text := '';
BEGIN
  IF to_regclass('public.companies') IS NOT NULL THEN
    has_timezone := EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'companies' AND column_name = 'timezone'
    );
    has_display_name := EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'companies' AND column_name = 'display_name'
    );
    has_updated_at := EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'companies' AND column_name = 'updated_at'
    );

    IF has_timezone THEN
      UPDATE public.companies
      SET timezone = 'Africa/Tunis'
      WHERE company_id = 'DEFAULT' AND (timezone IS NULL OR timezone = '');
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'companies' AND column_name = 'company_id'
    ) THEN
      cols := array_append(cols, 'company_id');
      vals := array_append(vals, quote_literal('DEFAULT'));
    END IF;

    IF has_display_name THEN
      cols := array_append(cols, 'display_name');
      vals := array_append(vals, quote_literal('DEFAULT'));
    END IF;

    IF has_timezone THEN
      cols := array_append(cols, 'timezone');
      vals := array_append(vals, quote_literal('Africa/Tunis'));
    END IF;

    IF array_length(cols, 1) IS NOT NULL THEN
      IF has_timezone THEN
        updates := 'timezone = COALESCE(public.companies.timezone, EXCLUDED.timezone)';
        IF has_updated_at THEN
          updates := updates || ', updated_at = now()';
        END IF;
      ELSIF has_updated_at THEN
        updates := 'updated_at = now()';
      END IF;

      IF updates <> '' THEN
        EXECUTE format(
          'INSERT INTO public.companies (%s) VALUES (%s) ON CONFLICT (company_id) DO UPDATE SET %s',
          array_to_string(cols, ', '),
          array_to_string(vals, ', '),
          updates
        );
      ELSE
        EXECUTE format(
          'INSERT INTO public.companies (%s) VALUES (%s) ON CONFLICT (company_id) DO NOTHING',
          array_to_string(cols, ', '),
          array_to_string(vals, ', ')
        );
      END IF;
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  tz_col text;
BEGIN
  IF to_regclass('public.company_config') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'company_config' AND column_name = 'company_timezone'
    ) THEN
      tz_col := 'company_timezone';
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'company_config' AND column_name = 'timezone'
    ) THEN
      tz_col := 'timezone';
    ELSE
      tz_col := NULL;
    END IF;

    IF tz_col IS NULL THEN
      EXECUTE 'INSERT INTO public.company_config (company_id) VALUES (''DEFAULT'') ON CONFLICT (company_id) DO NOTHING';
    ELSE
      EXECUTE format(
        'INSERT INTO public.company_config (company_id, %I) VALUES (''DEFAULT'', ''Africa/Tunis'') ' ||
        'ON CONFLICT (company_id) DO UPDATE SET %I = COALESCE(public.company_config.%I, EXCLUDED.%I)',
        tz_col,
        tz_col,
        tz_col,
        tz_col
      );
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  day_col text;
  working_col text;
BEGIN
  IF to_regclass('public.company_working_days') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'company_working_days' AND column_name = 'day_of_week'
    ) THEN
      day_col := 'day_of_week';
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'company_working_days' AND column_name = 'weekday'
    ) THEN
      day_col := 'weekday';
    ELSE
      day_col := NULL;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'company_working_days' AND column_name = 'is_working_day'
    ) THEN
      working_col := 'is_working_day';
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'company_working_days' AND column_name = 'is_working'
    ) THEN
      working_col := 'is_working';
    ELSE
      working_col := NULL;
    END IF;

    IF day_col IS NOT NULL AND working_col IS NOT NULL THEN
      EXECUTE format($q$
        INSERT INTO public.company_working_days (company_id, %I, %I)
        SELECT 'DEFAULT', v.day_num, v.is_working
        FROM (VALUES
          (0, false),
          (1, true),
          (2, true),
          (3, true),
          (4, true),
          (5, true),
          (6, false)
        ) AS v(day_num, is_working)
        ON CONFLICT (company_id, %I) DO UPDATE
          SET %I = EXCLUDED.%I
      $q$, day_col, working_col, day_col, working_col, working_col);
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.rule_sets') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.rule_sets) THEN
      INSERT INTO public.rule_sets (name, version)
      VALUES ('DEFAULT', 1)
      ON CONFLICT (name, version) DO NOTHING;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.policy_profiles') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.policy_profiles
      WHERE company_id = 'DEFAULT' AND name = 'DEFAULT' AND version = 1
    ) THEN
      INSERT INTO public.policy_profiles (company_id, name, version, params)
      VALUES ('DEFAULT', 'DEFAULT', 1, '{}'::jsonb)
      ON CONFLICT (company_id, name, version) DO NOTHING;
    END IF;
  END IF;
END $$;

COMMIT;
