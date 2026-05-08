BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_runtime_identities (
  identity_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  agent_id uuid NOT NULL,
  credential_hash text NOT NULL,
  credential_prefix text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  issued_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  issued_from_token_id uuid NULL,
  replaced_by_identity_id uuid NULL,
  replaced_reason text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_runtime_identities_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT agent_runtime_identities_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES public.agent_nodes(id) ON DELETE CASCADE,
  CONSTRAINT agent_runtime_identities_issued_from_token_id_fkey
    FOREIGN KEY (issued_from_token_id) REFERENCES public.agent_provisioning_tokens(id) ON DELETE SET NULL,
  CONSTRAINT agent_runtime_identities_replaced_by_identity_id_fkey
    FOREIGN KEY (replaced_by_identity_id) REFERENCES public.agent_runtime_identities(identity_id) ON DELETE SET NULL,
  CONSTRAINT agent_runtime_identities_status_ck
    CHECK (status IN ('active', 'revoked', 'replaced')),
  CONSTRAINT agent_runtime_identities_revoked_at_ck
    CHECK (
      (status = 'active' AND revoked_at IS NULL)
      OR
      (status IN ('revoked', 'replaced') AND revoked_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_runtime_identities_credential_hash
  ON public.agent_runtime_identities (credential_hash);

CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_runtime_identities_one_active_per_agent
  ON public.agent_runtime_identities (company_id, agent_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_agent_runtime_identities_company_agent_issued
  ON public.agent_runtime_identities (company_id, agent_id, issued_at DESC);

ALTER TABLE public.agent_nodes
  ADD COLUMN IF NOT EXISTS active_runtime_identity_id uuid NULL;

ALTER TABLE public.agent_nodes
  ADD COLUMN IF NOT EXISTS identity_status text NOT NULL DEFAULT 'bootstrap_only';

ALTER TABLE public.agent_nodes
  ADD COLUMN IF NOT EXISTS runtime_identity_issued_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_nodes_active_runtime_identity_id_fkey'
  ) THEN
    ALTER TABLE public.agent_nodes
      ADD CONSTRAINT agent_nodes_active_runtime_identity_id_fkey
      FOREIGN KEY (active_runtime_identity_id)
      REFERENCES public.agent_runtime_identities(identity_id)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_nodes_identity_status_ck'
  ) THEN
    ALTER TABLE public.agent_nodes
      ADD CONSTRAINT agent_nodes_identity_status_ck
      CHECK (identity_status IN ('bootstrap_only', 'active', 'revoked', 'replaced'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_nodes_active_runtime_identity_id
  ON public.agent_nodes (active_runtime_identity_id)
  WHERE active_runtime_identity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_nodes_company_identity_status
  ON public.agent_nodes (company_id, identity_status, updated_at DESC);

INSERT INTO public.agent_runtime_identities (
  company_id,
  agent_id,
  credential_hash,
  credential_prefix,
  status,
  issued_at,
  revoked_at,
  issued_from_token_id,
  metadata
)
SELECT
  a.company_id,
  a.id,
  a.auth_secret_hash,
  a.auth_secret_prefix,
  CASE
    WHEN lower(COALESCE(a.status, '')) = 'revoked' THEN 'revoked'
    ELSE 'active'
  END AS status,
  COALESCE(a.registered_at, a.created_at, now()) AS issued_at,
  CASE
    WHEN lower(COALESCE(a.status, '')) = 'revoked' THEN COALESCE(a.updated_at, a.registered_at, a.created_at, now())
    ELSE NULL
  END AS revoked_at,
  a.provisioned_from_token_id,
  jsonb_build_object(
    'source', 'migration.backfill',
    'agent_status_at_backfill', a.status
  )
FROM public.agent_nodes a
WHERE COALESCE(a.auth_secret_hash, '') <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM public.agent_runtime_identities ari
    WHERE ari.company_id = a.company_id
      AND ari.agent_id = a.id
  )
ON CONFLICT (credential_hash) DO NOTHING;

WITH latest_active_identity AS (
  SELECT DISTINCT ON (company_id, agent_id)
    company_id,
    agent_id,
    identity_id,
    issued_at
  FROM public.agent_runtime_identities
  WHERE status = 'active'
  ORDER BY company_id, agent_id, issued_at DESC, created_at DESC, identity_id DESC
)
UPDATE public.agent_nodes a
SET active_runtime_identity_id = lai.identity_id,
    identity_status = 'active',
    runtime_identity_issued_at = lai.issued_at,
    updated_at = now()
FROM latest_active_identity lai
WHERE a.company_id = lai.company_id
  AND a.id = lai.agent_id
  AND (
    a.active_runtime_identity_id IS DISTINCT FROM lai.identity_id
    OR a.identity_status IS DISTINCT FROM 'active'
    OR a.runtime_identity_issued_at IS DISTINCT FROM lai.issued_at
  );

UPDATE public.agent_nodes a
SET active_runtime_identity_id = NULL,
    identity_status = 'revoked',
    runtime_identity_issued_at = NULL,
    updated_at = now()
WHERE lower(COALESCE(a.status, '')) = 'revoked'
  AND (
    a.active_runtime_identity_id IS NOT NULL
    OR a.identity_status IS DISTINCT FROM 'revoked'
    OR a.runtime_identity_issued_at IS NOT NULL
  );

UPDATE public.agent_nodes a
SET active_runtime_identity_id = NULL,
    identity_status = 'bootstrap_only',
    runtime_identity_issued_at = NULL,
    updated_at = now()
WHERE lower(COALESCE(a.status, '')) <> 'revoked'
  AND NOT EXISTS (
    SELECT 1
    FROM public.agent_runtime_identities ari
    WHERE ari.company_id = a.company_id
      AND ari.agent_id = a.id
      AND ari.status = 'active'
  )
  AND (
    a.active_runtime_identity_id IS NOT NULL
    OR a.identity_status IS DISTINCT FROM 'bootstrap_only'
    OR a.runtime_identity_issued_at IS NOT NULL
  );

COMMIT;
