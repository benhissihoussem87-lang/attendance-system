BEGIN;

ALTER TABLE public.agent_device_event_batches
  ADD COLUMN IF NOT EXISTS delivery_id text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_device_event_batches_company_agent_delivery
  ON public.agent_device_event_batches (company_id, agent_id, delivery_id)
  WHERE delivery_id IS NOT NULL;

COMMIT;
