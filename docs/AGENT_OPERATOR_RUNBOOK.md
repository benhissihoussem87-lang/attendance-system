# Agent Operator Runbook

This runbook is the minimum local/internal-demo procedure for running the product app with the local LAN agent. It is intentionally not a Windows service, installer, or agent security refactor.

## Scope

Use this when `/app` is available but live device workflows are blocked because the agent heartbeat/runtime state is stale.

This runbook covers:
- starting the server
- starting the agent
- checking server, agent, diagnostics, heartbeat, and K80 reachability
- recovering from stale agent status

This runbook does not change:
- K80 parser
- RT decoder
- full-history protocol
- enrollment
- command/session governance
- Auth v1

## Known Product Baseline

- `/app` is the product route and requires human login.
- Operations, Settings, Employees, and Attendance are available after login.
- Operations live workflows require `agent/index.js` to be running.
- If the agent is stopped, the app may show stale agent/runtime status. That is an operations/runtime condition, not a K80 parser failure.

## Required Local Environment

Server-side `.env` must keep product-safe auth and RT ingest policy enabled:

```powershell
REQUIRE_AUTH=true
K80_RT_01F4_INGEST_ENABLED=true
K80_RT_01F4_INGEST_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486
K80_RT_01F4_RECONCILE_WINDOW_MS=5000
```

Agent-side local environment:

```powershell
$env:SAAS_BASE_URL = "http://127.0.0.1:3000"
$env:K80_RT_SUBSCRIBER_ENABLED = "true"
$env:K80_RT_SUBSCRIBER_DEVICE_UID_ALLOWLIST = "zkteco:sn:BIND-QUEUE-c26a7486"
```

The agent also needs one of:
- existing `agent/.state/agent-state.json` containing its registered identity/token, or
- `AGENT_PROVISIONING_TOKEN` for first-time setup.

Do not print provisioning tokens or agent bearer tokens in runbooks, screenshots, or logs.

## Start Server

From the repository root:

```powershell
npm start
```

Expected:
- server listens on `127.0.0.1:3000` / `localhost:3000`
- unauthenticated `/api/auth/me` returns `401`, proving auth is active

## Start Agent

From another terminal in the repository root:

```powershell
npm run agent:start:local
```

The helper starts the agent in known-good local/internal K80 mode. It sets missing local env for:
- `SAAS_BASE_URL=http://127.0.0.1:3000`
- `K80_RT_SUBSCRIBER_ENABLED=true`
- `K80_RT_SUBSCRIBER_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`

It prints non-secret effective config before starting the agent.

Generic bridge start remains available, but it is not enough for K80 live monitoring unless the K80 RT subscriber policy is already present in the shell environment:

```powershell
npm run agent:start
```

The helper runs the agent in the foreground. It does not install a service, daemonize, or hide errors.

Expected startup log fields for K80 live monitoring:

```text
k80_rt_subscriber_enabled=true
k80_rt_subscriber_device_uid=zkteco:sn:BIND-QUEUE-c26a7486
```

If startup shows `k80_rt_subscriber_enabled=false` or `k80_rt_subscriber_device_uid=null`, the agent may heartbeat and poll commands but `START_DEVICE_MONITORING` can fail before live RT starts.

## Check Baseline

Run:

```powershell
npm run ops:check-agent
```

The script is read-only. It checks:
- server port `3000`
- unauthenticated auth probe behavior
- `agent/index.js` process presence
- diagnostics port `4780`
- diagnostics `/api/local-diagnostics/health`
- K80 RT subscriber policy evidence from diagnostics when available
- active agent heartbeat freshness when PostgreSQL access is available
- K80 TCP reachability at `192.168.22.201:4370`

Expected healthy demo baseline:

```text
SERVER_OK
AUTH_PROBE_OK
AGENT_PROCESS_OK
AGENT_DIAGNOSTICS_OK
AGENT_RT_POLICY_ENABLED
HEARTBEAT_FRESH
K80_REACHABLE
```

If `AGENT_RT_POLICY_UNKNOWN` appears before the first monitoring attempt, inspect the agent startup log for the two K80 RT subscriber fields above.

## Verify In Browser

1. Open `http://127.0.0.1:3000/login/`.
2. Log in with a valid DEFAULT admin/operator account.
3. Open `/app`.
4. Confirm Operations shows the real K80 under `Default Site`.
5. Confirm Connect/Disconnect/Sync controls are visible according to role.

Do not run live RT or Sync unless the operator intentionally validates those workflows.

## Recover From Stale Agent Status

If `/app` shows an agent stale message:

1. Check whether the agent process is running:

```powershell
npm run ops:check-agent
```

2. If `AGENT_NOT_RUNNING`, start it:

```powershell
npm run agent:start:local
```

3. Wait for one heartbeat cycle. Default heartbeat interval is 30 seconds.
4. Re-run:

```powershell
npm run ops:check-agent
```

5. Refresh `/app`.

Do not bypass execution gates. Stale heartbeat means the SaaS cannot safely prove the local executor is alive.

## Recover From K80 Monitoring Policy Disabled

If `/app` Connect fails after the agent starts, inspect the agent startup log.

Failure pattern:

```text
k80_rt_subscriber_enabled=false
k80_rt_subscriber_device_uid=null
```

Recovery:

1. Stop the current foreground agent with `Ctrl+C`.
2. Restart with the local K80 helper:

```powershell
npm run agent:start:local
```

3. Confirm startup log shows:

```text
k80_rt_subscriber_enabled=true
k80_rt_subscriber_device_uid=zkteco:sn:BIND-QUEUE-c26a7486
```

4. Run:

```powershell
npm run ops:check-agent
```

5. Wait for a fresh heartbeat.
6. Retry Connect in `/app`.

This is agent-side local RT subscriber config. It is not backend RT ingest policy, K80 parser, RT decoder, full-history protocol, or enrollment.

## K80 Reachability Check

The baseline checker performs a TCP reachability check for:

```text
192.168.22.201:4370
```

If K80 is unreachable:
- verify the device is powered on
- verify the operator machine is on the correct LAN/VPN
- verify no firewall blocks port `4370`

Do not change parser or protocol code to fix LAN reachability.

## Do Not Repeat

- Stale heartbeat is not a K80 parser, RT decoder, or full-history protocol failure.
- Agent process running is not enough for K80 live monitoring; local RT subscriber policy must be enabled and allowlisted.
- RT captured by the agent but not inserted can be backend RT ingest policy. Check batch diagnostics before touching protocol code.
- Session expired or `unauthorized` in `/app` is an auth/login issue, not RT failure.
- Do not disable `REQUIRE_AUTH` for product demos.
- Do not auto-start the agent from the browser/server in this baseline.

## Future Work Not In This Baseline

Later productization can add:
- managed Windows service
- installer/update path
- local service health monitor
- stronger local hardening/obfuscation
- thin-agent security refactor

For now, keep the agent a local LAN executor and keep policy, permissions, and product value server-side.
