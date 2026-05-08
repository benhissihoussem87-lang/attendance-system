BEGIN;

CREATE OR REPLACE FUNCTION public.devices_prevent_device_uid_mutation_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.device_uid IS DISTINCT FROM OLD.device_uid THEN
    RAISE EXCEPTION 'devices.device_uid is immutable; use alias + supersession flow'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_devices_device_uid_immutable ON public.devices;

CREATE TRIGGER trg_devices_device_uid_immutable
BEFORE UPDATE OF device_uid ON public.devices
FOR EACH ROW
EXECUTE FUNCTION public.devices_prevent_device_uid_mutation_fn();

COMMIT;
