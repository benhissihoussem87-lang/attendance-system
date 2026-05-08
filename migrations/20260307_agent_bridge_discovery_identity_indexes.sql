BEGIN;

CREATE INDEX IF NOT EXISTS idx_devices_company_discovery_serial_lower
  ON public.devices (company_id, lower((discovery_metadata->>'serial_number')));

CREATE INDEX IF NOT EXISTS idx_devices_company_discovery_mac_lower
  ON public.devices (company_id, lower((discovery_metadata->>'mac')));

COMMIT;
