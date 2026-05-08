BEGIN;

CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL REFERENCES public.companies(company_id) ON DELETE RESTRICT,
  email text NOT NULL,
  email_normalized text NOT NULL,
  password_hash text NOT NULL,
  password_algo text NOT NULL DEFAULT 'scrypt_v1',
  role text NOT NULL DEFAULT 'viewer',
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_check CHECK (role IN ('admin', 'operator', 'viewer')),
  CONSTRAINT users_email_nonempty CHECK (length(trim(email)) > 0),
  CONSTRAINT users_email_normalized_nonempty CHECK (length(trim(email_normalized)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_unique
  ON public.users (email_normalized);

CREATE INDEX IF NOT EXISTS users_company_id_idx
  ON public.users (company_id);

CREATE TABLE IF NOT EXISTS public.user_sessions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id text NOT NULL REFERENCES public.companies(company_id) ON DELETE RESTRICT,
  session_token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_token_hash_unique
  ON public.user_sessions (session_token_hash);

CREATE INDEX IF NOT EXISTS user_sessions_user_active_idx
  ON public.user_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS user_sessions_company_id_idx
  ON public.user_sessions (company_id);

COMMIT;
