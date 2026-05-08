# Local Agent Bridge Foundation + ZKTeco Pull Ingestion

Operational runbook: [`docs/BRIDGE_OPERATIONS_RUNBOOK.md`](./BRIDGE_OPERATIONS_RUNBOOK.md)

## Why a Local Agent is required
- Fingerprint devices are inside each customer private LAN.
- Cloud SaaS cannot reliably discover private LAN devices directly over the public internet.
- Correct model: outbound connection from LAN to SaaS.

## Implemented architecture (this slice)
1. SaaS admin creates a company-scoped provisioning token.
2. Local Agent boots inside customer LAN using that provisioning token.
3. Agent bootstrap creates a persistent `agent_nodes` identity and bearer credential.
4. Agent sends periodic heartbeat to SaaS.
5. SaaS queues `SCAN_SUBNET` command for an agent.
6. Agent polls `commands/next`, runs discovery adapter, posts discovery report.
7. SaaS stores discovered devices as `managed_status='candidate'` under company scope.
8. SaaS admin claims candidate device into managed registry (`managed_status='managed'`).
9. SaaS admin queues `PULL_DEVICE_EVENTS` for a managed ZKTeco device.
10. Agent pulls attendance logs from device over LAN (UDP/4370 protocol path).
11. Agent normalizes logs to stable event contract and submits batch to SaaS.
12. SaaS ingests idempotently into `device_events`, updates sync cursor/status, and acknowledges command.

## Communication model decision
- Chosen model: outbound HTTPS polling.
- Reason: simplest robust fit for existing Express + Postgres codebase, no inbound LAN exposure, no extra broker/service required for first slice.

## Implemented backend surfaces
- Admin endpoints (`x-api-key`, role-enforced):
  - `POST /api/agent-admin/provisioning-tokens`
  - `POST /api/agent-admin/agents/:agentId/commands/scan-subnet`
  - `POST /api/agent-admin/agents/:agentId/commands/pull-device-events`
  - `GET /api/agent-admin/agents`
  - `GET /api/agent-admin/commands`
  - `GET /api/agent-admin/device-event-batches`
  - `GET /api/agent-admin/device-sync-states`
  - `GET /api/agent-admin/discovered-devices`
  - `POST /api/agent-admin/discovered-devices/:deviceUid/claim`
  - `PUT /api/agent-admin/devices/:deviceUid/remediation`
- Agent endpoints (bearer token, separate from user API key):
  - `POST /api/agent/bootstrap`
  - `POST /api/agent/heartbeat`
  - `POST /api/agent/commands/next`
  - `POST /api/agent/discovery-reports`
  - `POST /api/agent/device-events/batch`

## Discovery adapter boundary
- Agent adapter contract: `discover(subnetTargets, options) => { discovered_devices[], summary }`.
- Standardized fields:
  - `ip`, `mac`, `vendor`, `model`, `serial_number`, `device_uid`
  - `discovery_method`, `confidence`, `confidence_class`
  - `outcome_class` (`confirmed` | `probable` | `heuristic`)
  - `confirmation_state` (`confirmed` | `zk_service_reachable` | `host_reachable`)
  - `failure_reason` (`timeout` | `auth_required` | `auth_failed` | `protocol_error` | `malformed_response` | `socket_error` | `network_unreachable`)
  - `identity_source`, `protocol`, `observed_at`, `raw`
- First adapter: `zkteco` probe adapter with:
  - UDP protocol handshake on port `4370` (`CMD_CONNECT`) for zk-service detection
  - optional protocol auth attempt (`CMD_AUTH`) when `options.auth_password` is provided
  - protocol option interrogation when handshake is authorized:
    - `~SerialNumber`, `~DeviceName`, `~Platform`, `MAC`, `CMD_GET_VERSION`
  - confidence classification from protocol evidence (confirmed/probable/heuristic)
  - per-host protocol evidence and failure taxonomy in `summary.host_observations[]`
  - TCP `4370` fallback heuristic when protocol interrogation is unavailable
  - deterministic mock mode for tests (`AGENT_DISCOVERY_MOCK=1`)

## Discovery and claim lifecycle
- Candidate discovered: `devices.managed_status='candidate'`, `source='agent_discovery'`.
- `devices.discovery_status` now reflects confidence tier:
  - `confirmed` (zk handshake + stable identity from serial/mac)
  - `probable` (zk response/handshake without stable identity)
  - `heuristic` (TCP service reachability only)
- Claim action: transitions candidate to `managed`, stamps `claimed_at`, `claimed_by_key_id`.
- Existing managed devices are not downgraded to candidate by later discovery reports.
- Stable identity reconciliation (additive hardening):
  - if a candidate was first discovered as `vendor:ip:*` and later discovered with stable serial/mac, SaaS promotes candidate UID to stable UID when safe.
  - identity matching is company-scoped and checks serial/mac evidence from discovery metadata.

## Safe scanning controls
- `SCAN_SUBNET` payload enforces:
  - non-empty `subnet_targets`
  - max 8 targets
  - RFC1918 private IPv4 only
  - CIDR prefix `/16` to `/32`
  - bounded `timeout_ms` and `max_hosts`

## Local agent runtime
- Location: `agent/`.
- Minimal operational behavior:
  - bootstrap if local state is missing
  - persist identity in local state file
  - heartbeat loop
  - command polling loop
  - scan command execution and report submission
  - pull-event command execution and batch submission
  - disk-backed retry buffer for failed batch submissions (`AGENT_EVENT_QUEUE_FILE`)

## ZKTeco pull ingestion contract
- Pull command payload (`PULL_DEVICE_EVENTS`) includes:
  - `device_uid`, `vendor`, `ingest_method`
  - `connection.host`, `connection.port`, optional `connection.auth_password`
  - `pull.requested_since_utc`, `pull.lookback_minutes`, `pull.safety_window_minutes`, `pull.max_events`, `pull.device_timezone`
- Agent batch payload (`POST /api/agent/device-events/batch`) includes:
  - `command_id`, `run_id`, `device_uid`, `vendor`, `ingest_method`
  - cursor object (`requested_since_utc`, `latest_event_time_utc`, `has_more`)
  - normalized `events[]` with `device_person_id`, local+UTC timestamps, `direction`, verify fields, `dedup_key`, `raw`
  - `summary`/diagnostics for pull evidence

## Dedup, cursor, and backfill model
- Dedup:
  - `device_events` now stores `dedup_key`.
  - unique index: `(company_id, dedup_key)` where `dedup_key` is not null.
  - insert path uses `ON CONFLICT DO NOTHING` for replay-safe ingestion.
- Cursor:
  - per `(company_id, agent_id, device_uid)` sync state in `agent_device_sync_states`.
  - next pull starts from `max(cursor_event_time_utc, options.since_utc)` minus safety window.
- Backfill/retry:
  - safety window allows overlap to avoid edge loss.
  - overlapping windows are safe because dedup is stable.
  - agent stores failed batch submits in disk buffer and retries before polling next command.

## Pull diagnostics and evidence
- Agent logs structured events:
  - `agent.events.pull.started`
  - `agent.events.pull.completed`
  - `agent.events.batch_submit.succeeded|failed`
  - `agent.events.batch_buffered`
  - `agent.events.buffer.flush_started|completed`
- Pull diagnostics include:
  - protocol ack/auth outcomes
  - parser candidate counts and parse errors
  - latest event cursor evidence

## Live diagnostics for LAN validation
- Agent emits structured JSON logs (`scope='agent_bridge'`) for:
  - bootstrap request/success/failure
  - heartbeat success/failure
  - command poll receive/empty/failure
  - scan start/completion
  - per-host result (`outcome_class`, `failure_reason`, protocol/auth flags, serial/mac)
  - discovery report submit success/failure
- SaaS emits structured JSON logs (`scope='saas_bridge'`) for:
  - bootstrap/heartbeat/command/report endpoint request+result
  - discovery report persistence commit
  - per-device candidate persistence outcome
  - claim outcome
- Correlation fields:
  - `command_id` (admin-issued command)
  - `run_id` (agent scan run UUID, included in report summary and SaaS logs)

## Manual LAN validation tooling
- CLI: `node scripts/agent/discovery-probe.js`
- Pull CLI: `node scripts/agent/pull-events-probe.js`
- Examples:
  - subnet scan:
    - `node scripts/agent/discovery-probe.js --target 192.168.1.0/24 --timeout-ms 1200 --max-hosts 256 --json-out .tmp/zk-scan.json`
  - single host:
    - `node scripts/agent/discovery-probe.js --host 192.168.1.20 --timeout-ms 1500 --json-out .tmp/zk-host.json`
  - auth-required probe:
    - `node scripts/agent/discovery-probe.js --host 192.168.1.20 --auth-password 1234 --json-out .tmp/zk-auth.json`
  - deterministic mock:
    - `node scripts/agent/discovery-probe.js --host 192.168.1.20 --mock`
  - event pull (real):
    - `node scripts/agent/pull-events-probe.js --host 192.168.1.20 --auth-password 1234 --since-utc 2026-03-06T00:00:00Z --json-out .tmp/zk-pull.json`
  - event pull (deterministic mock):
    - `node scripts/agent/pull-events-probe.js --mock --device-uid zkteco:sn:MOCK001 --json-out .tmp/zk-pull-mock.json`
- CLI behavior:
  - read-only network probing only; no destructive device commands.
  - outputs JSON evidence with `summary`, `host_results`, and normalized `discovered_devices`.

## Implemented now vs later
- Implemented now:
  - provisioning, registration, heartbeat
  - command queue foundation
  - subnet scan command contract
  - discovery report ingestion
  - candidate registry + claim flow
  - first vendor adapter boundary with zkteco probe/mock
  - first ZKTeco pull ingestion path to `device_events` with dedup/cursor/sync-state
  - disk-backed agent retry buffer for batch submission failures
- Deferred:
  - credential rotation endpoint/workflow
  - richer command scheduler/dead-letter handling
  - optional realtime event acceleration path (pull remains source of correctness)
  - future push/ADMS mode endpoint and adapter implementation
  - UI workflows beyond API/admin readiness
