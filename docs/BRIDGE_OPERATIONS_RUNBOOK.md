# Bridge Operations Runbook (Day-2 Triage)

This runbook is for support/operator triage of Local Agent bridge issues in production-like environments.

Scope:
- device onboarding/remediation visibility,
- command lifecycle visibility,
- sync freshness and ingestion failures,
- identity-mapping rejection diagnosis.

Out of scope:
- vendor expansion,
- realtime/push redesign,
- attendance engine redesign.

## 1. Preconditions
- Backend running and reachable.
- API key with at least `viewer` role for read checks.
- API key with `operator` role for remediation actions.
- Company context known (`COMPANY_ID`).

Example environment:
```powershell
$BASE = "http://localhost:3000"
$COMPANY = "DEFAULT"
$VIEWER_KEY = "<viewer-or-admin-key>"
$OP_KEY = "<operator-or-admin-key>"
```

## 2. Quick Health Gate
```powershell
Invoke-RestMethod "$BASE/api/ops/health"
Invoke-RestMethod "$BASE/api/ops/ready"
```

If either fails, stop and recover platform health first.

## 3. Agent Connectivity Check
List agents:
```powershell
Invoke-RestMethod "$BASE/api/agent-admin/agents?company_id=$COMPANY&limit=50" -Headers @{ "x-api-key" = $VIEWER_KEY }
```

If needed, filter by status or recent sighting:
```powershell
Invoke-RestMethod "$BASE/api/agent-admin/agents?company_id=$COMPANY&status=active&seen_since=2026-03-14T00:00:00Z" -Headers @{ "x-api-key" = $VIEWER_KEY }
```

Decision:
- No active/recent agents: triage agent deployment/connectivity first.
- Active agent present: continue to device-level triage.

## 4. Device Onboarding / Remediation Check
List operational device states:
```powershell
Invoke-RestMethod "$BASE/api/devices?company_id=$COMPANY&limit=100" -Headers @{ "x-api-key" = $VIEWER_KEY }
```

Focused checks:
```powershell
Invoke-RestMethod "$BASE/api/devices?company_id=$COMPANY&managed_status=candidate" -Headers @{ "x-api-key" = $VIEWER_KEY }
Invoke-RestMethod "$BASE/api/devices?company_id=$COMPANY&manageability_status=blocked" -Headers @{ "x-api-key" = $VIEWER_KEY }
Invoke-RestMethod "$BASE/api/devices?company_id=$COMPANY&remediation_manual_status=needs_field_action" -Headers @{ "x-api-key" = $VIEWER_KEY }
```

Interpretation:
- `candidate`: discovered but not fully onboarded.
- `blocked`: operational failure observed; device not ingestion-ready.
- `needs_field_action`: manual remediation required in field.

## 5. Command Lifecycle Check
List command lifecycle for an agent/device:
```powershell
Invoke-RestMethod "$BASE/api/agent-admin/commands?company_id=$COMPANY&agent_id=<AGENT_ID>&device_uid=<DEVICE_UID>&limit=50" -Headers @{ "x-api-key" = $VIEWER_KEY }
```

Filter by status:
```powershell
Invoke-RestMethod "$BASE/api/agent-admin/commands?company_id=$COMPANY&status=failed&limit=50" -Headers @{ "x-api-key" = $VIEWER_KEY }
```

Decision:
- repeated `failed`/`expired`: inspect batch and sync diagnostics next.
- `acknowledged` with recent timestamps: command flow is healthy.

## 6. Sync Freshness Check
```powershell
Invoke-RestMethod "$BASE/api/agent-admin/device-sync-states?company_id=$COMPANY&agent_id=<AGENT_ID>&device_uid=<DEVICE_UID>" -Headers @{ "x-api-key" = $VIEWER_KEY }
```

Fields to watch:
- `status`
- `cursor_event_time_utc`
- `last_sync_started_at`
- `last_sync_completed_at`
- `failure_reason`

Decision:
- `status=error` with stale cursor: ingestion is blocked.
- advancing cursor with regular completion: ingestion path is healthy.

## 7. Batch Failure / Rejection Diagnostics
```powershell
Invoke-RestMethod "$BASE/api/agent-admin/device-event-batches?company_id=$COMPANY&agent_id=<AGENT_ID>&device_uid=<DEVICE_UID>&limit=50" -Headers @{ "x-api-key" = $VIEWER_KEY }
```

Failure-focused query:
```powershell
Invoke-RestMethod "$BASE/api/agent-admin/device-event-batches?company_id=$COMPANY&status=rejected&limit=50" -Headers @{ "x-api-key" = $VIEWER_KEY }
```

Use:
- `failure_reason`
- `inserted_count` / `deduped_count` / `rejected_count`
- `rejection_samples` (bounded sample summary)

## 8. Common Triage Branches
### A) Discovered but not manageable
Indicators:
- device present but `manageability_status` is `blocked`/`reachable`/`protocol_reachable`,
- no successful ingestion batches.

Action:
- keep/mark manual remediation state:
```powershell
Invoke-RestMethod "$BASE/api/agent-admin/devices/<DEVICE_UID>/remediation?company_id=$COMPANY" `
  -Method PUT `
  -Headers @{ "x-api-key" = $OP_KEY; "content-type" = "application/json" } `
  -Body '{"company_id":"DEFAULT","remediation_status":"needs_field_action","note":"Needs onsite reprovision","owner":"field-tech"}'
```
- coordinate field unlock/reprovisioning.

### B) Identity mapping missing (events rejected)
Indicators:
- batch `failure_reason=identity_mapping_missing`,
- nonzero `rejected_count`,
- sync state may show `error` with mapping failure.

Action:
1. add/fix identity mapping via existing identity-mapping APIs,
2. trigger pull retry,
3. confirm new batch is `accepted`/`partial`,
4. confirm sync cursor advances and device progresses to ingesting evidence.

### C) Blocked device recovered after retry
Expected progression:
1. device `manageability_status=blocked`,
2. retry command + successful batch with accepted evidence,
3. device moves to `manageability_status=ingesting`,
4. sync state returns to `idle` with fresher cursor.

## 9. Evidence Capture for Escalation
Capture and attach:
- `/api/agent-admin/agents` sample for impacted agent,
- `/api/devices` row for impacted device,
- `/api/agent-admin/commands` rows for recent attempts,
- `/api/agent-admin/device-sync-states` row,
- `/api/agent-admin/device-event-batches` failure row(s) and rejection samples.

Keep timestamps in UTC in escalation notes.

## 10. Lifecycle Integrity Guardrail Report (Phase 5)
Use this read-only DB report to detect long-term lifecycle drift before any cleanup or reclassification.

Run:
```powershell
. .\scripts\db\load-env.ps1
psql -f .\scripts\db\lifecycle-coherence-integrity-report.sql
```

What it checks:
- required lifecycle migrations are applied (`slice21`, `slice25`),
- strict integrity counts (expected `0`) for supersession, alias, and managing-agent-binding invariants,
- advisory counts for likely classification drift (`ingest_only` rows with bridge evidence),
- sample detail rows for each anomaly class.

Operational rule:
- treat this report as a gate before manual lifecycle cleanup.
- if strict checks are nonzero, capture rows and resolve root cause first.
- for advisory checks, confirm evidence before any row-level rewrite.
