BEGIN;

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS manageability_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS manageability_reason text NULL;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS manageability_updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS manageability_last_proven_at timestamptz NULL;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS remediation_manual_status text NULL;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS remediation_manual_note text NULL;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS remediation_manual_owner text NULL;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS remediation_manual_updated_at timestamptz NULL;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS remediation_manual_updated_by_key_id text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_manageability_status_ck'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_manageability_status_ck
      CHECK (
        manageability_status IN (
          'unknown',
          'reachable',
          'protocol_reachable',
          'blocked',
          'manageable',
          'ingesting'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_manageability_reason_ck'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_manageability_reason_ck
      CHECK (
        manageability_reason IS NULL OR
        manageability_reason IN (
          'discovery_host_reachable',
          'discovery_protocol_reachable',
          'discovery_confirmed',
          'network_unreachable',
          'timeout',
          'connect_timeout',
          'auth_required',
          'auth_failed',
          'protocol_error',
          'malformed_response',
          'socket_error',
          'attlog_timeout',
          'attlog_error',
          'empty_data',
          'missing_host',
          'unsupported_vendor',
          'pull_failed',
          'ingestion_rejected',
          'pull_succeeded',
          'ingestion_accepted',
          'manual_needs_field_action',
          'unknown_error'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_manageability_proven_ck'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_manageability_proven_ck
      CHECK (
        manageability_status NOT IN ('manageable', 'ingesting')
        OR manageability_last_proven_at IS NOT NULL
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_remediation_manual_status_ck'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_remediation_manual_status_ck
      CHECK (
        remediation_manual_status IS NULL
        OR remediation_manual_status IN ('needs_field_action')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_remediation_manual_fields_ck'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_remediation_manual_fields_ck
      CHECK (
        (remediation_manual_status IS NOT NULL AND remediation_manual_updated_at IS NOT NULL)
        OR (
          remediation_manual_status IS NULL
          AND remediation_manual_note IS NULL
          AND remediation_manual_owner IS NULL
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_remediation_manual_note_len_ck'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_remediation_manual_note_len_ck
      CHECK (
        remediation_manual_note IS NULL
        OR char_length(remediation_manual_note) <= 2000
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_remediation_manual_owner_len_ck'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_remediation_manual_owner_len_ck
      CHECK (
        remediation_manual_owner IS NULL
        OR char_length(remediation_manual_owner) <= 255
      );
  END IF;
END $$;

UPDATE public.devices
SET manageability_status = COALESCE(manageability_status, 'unknown'),
    manageability_updated_at = COALESCE(manageability_updated_at, now())
WHERE manageability_status IS NULL
   OR manageability_updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_devices_company_manageability_status
  ON public.devices (company_id, manageability_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_devices_company_manual_remediation_status
  ON public.devices (company_id, remediation_manual_status, updated_at DESC)
  WHERE remediation_manual_status IS NOT NULL;

COMMIT;
