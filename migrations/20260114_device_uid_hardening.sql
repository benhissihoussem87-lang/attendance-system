BEGIN;

ALTER TABLE device_events
  ALTER COLUMN device_uid DROP DEFAULT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'device_events_device_uid_nonempty'
  ) THEN
    ALTER TABLE device_events
      ADD CONSTRAINT device_events_device_uid_nonempty
      CHECK (btrim(device_uid) <> '')
      NOT VALID;
  END IF;
END $$;

COMMIT;

-- Follow-up (do not run now):
-- ALTER TABLE device_events VALIDATE CONSTRAINT device_events_device_uid_nonempty;
