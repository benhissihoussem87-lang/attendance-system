# Data Hygiene Runbook

This runbook is non-destructive. Historical rows are evidence until they are backed up, classified, and explicitly archived by a later approved cleanup.

## Backup Prerequisite

Before any future cleanup, classification mutation, archive, or purge, create a full PostgreSQL custom-format backup:

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path C:\attendance-system\backups | Out-Null
pg_dump -h localhost -p 5432 -U postgres -Fc -f "C:\attendance-system\backups\attendance-$stamp.before-data-hygiene.dump" attendance
pg_restore -l "C:\attendance-system\backups\attendance-$stamp.before-data-hygiene.dump" | Select-Object -First 20
```

Do not put database passwords in command history. Use the existing local environment or a secure local password mechanism.

## Read-Only Report

Run:

```powershell
node scripts\data-hygiene\report.js
```

Optional:

```powershell
$env:DATA_HYGIENE_COMPANY_ID='DEFAULT'
$env:DATA_HYGIENE_REPORT_LIMIT='5'
node scripts\data-hygiene\report.js
```

The report only reads data. It summarizes counts and examples for product, validation, test/dev/generated, protocol evidence, auth validation, and unknown rows.

## Preservation Rule

Do not delete or mutate these evidence surfaces during product cleanup:

- K80 `device_events`
- `device_realtime_direction_observations`
- `agent_commands`
- `agent_device_event_batches`
- `device_monitoring_sessions`
- runtime/device/site capability reported-state tables
- K80 device/site/agent binding and lease rows

Product APIs should hide non-product data by default where safe, while internal diagnostics and direct evidence access remain available.
