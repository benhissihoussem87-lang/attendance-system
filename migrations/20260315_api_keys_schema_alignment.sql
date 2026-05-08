BEGIN;

CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  api_key text NOT NULL,
  company_id text NOT NULL,
  role text NOT NULL DEFAULT 'viewer',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS api_key text;
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS role text DEFAULT 'viewer';
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz NULL;
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

UPDATE public.api_keys
SET
  api_key = btrim(COALESCE(api_key, '')),
  company_id = COALESCE(company_id, 'DEFAULT'),
  role = lower(btrim(COALESCE(role, 'viewer'))),
  active = COALESCE(active, true),
  created_at = COALESCE(created_at, now()),
  updated_at = COALESCE(updated_at, now()),
  metadata = COALESCE(metadata, '{}'::jsonb);

ALTER TABLE public.api_keys
  ALTER COLUMN api_key SET NOT NULL;
ALTER TABLE public.api_keys
  ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.api_keys
  ALTER COLUMN role SET NOT NULL;
ALTER TABLE public.api_keys
  ALTER COLUMN active SET NOT NULL;
ALTER TABLE public.api_keys
  ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.api_keys
  ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE public.api_keys
  ALTER COLUMN metadata SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_company_id_fkey'
  ) THEN
    ALTER TABLE public.api_keys
      ADD CONSTRAINT api_keys_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_role_ck'
  ) THEN
    ALTER TABLE public.api_keys
      ADD CONSTRAINT api_keys_role_ck
      CHECK (role IN ('viewer', 'operator', 'admin'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_api_key_nonempty_ck'
  ) THEN
    ALTER TABLE public.api_keys
      ADD CONSTRAINT api_keys_api_key_nonempty_ck
      CHECK (btrim(api_key) <> '');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_api_keys_api_key
  ON public.api_keys (api_key);

CREATE INDEX IF NOT EXISTS idx_api_keys_company_active
  ON public.api_keys (company_id, active);

COMMIT;
