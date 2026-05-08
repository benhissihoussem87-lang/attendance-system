const {
  getAgentById,
  getActiveManagingAgentBinding,
  resolveCanonicalDeviceUidForOperations
} = require('./agentBridgeDb');
const { evaluateCommandIssuanceGate } = require('./executionGating');
const { COMMAND_TYPES } = require('../contracts/agentBridgeContract');

const ACTIVE_STATUSES = new Set(['starting', 'active']);
const TERMINAL_STATUSES = new Set(['stopped', 'expired', 'failed']);

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parsePositiveInt(value, fallback) {
  if (Number.isInteger(value)) {
    return value > 0 ? value : fallback;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return parsed > 0 ? parsed : fallback;
  }
  return fallback;
}

function parseBool(value, fallback = true) {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

function parseIntegerLike(value) {
  if (Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function normalizeConnectionFromDeviceMetadata(metadata) {
  const source = isPlainObject(metadata) ? metadata : {};
  const manual = isPlainObject(source.manual_onboarding) ? source.manual_onboarding : {};
  const manualConnection = isPlainObject(manual.connection) ? manual.connection : {};
  const connection = isPlainObject(source.connection) ? source.connection : {};
  const merged = {
    ...source,
    ...connection,
    ...manualConnection
  };
  const authPassword = parseIntegerLike(merged.auth_password)
    ?? parseIntegerLike(merged.communication_key)
    ?? parseIntegerLike(merged.comm_key);
  return {
    host: normalizeText(merged.host || merged.ip || merged.address) || null,
    port: parseIntegerLike(merged.port) || 4370,
    transport: normalizeText(merged.transport).toLowerCase() || 'tcp',
    auth_password: Number.isInteger(authPassword) ? authPassword : null,
    device_number: parseIntegerLike(merged.device_number) || 1
  };
}

function buildStartCommandPayload({ session, device, leaseExpiresAt }) {
  return {
    monitoring_session_id: session.id,
    device_uid: session.device_uid,
    vendor: normalizeText(device.provider).toLowerCase() || 'zkteco',
    rt_enabled: session.rt_enabled !== false,
    lease_expires_at: leaseExpiresAt || session.expires_at || null,
    connection: normalizeConnectionFromDeviceMetadata(device.metadata),
    runtime_policy: {
      rt_01f4_ingest_required: true,
      reconcile_window_ms: 5000,
      require_person_parse: true
    }
  };
}

function buildStopCommandPayload({ session, reason }) {
  return {
    monitoring_session_id: session.id,
    device_uid: session.device_uid,
    reason: normalizeText(reason) || 'operator_stop'
  };
}

function normalizeSessionRow(row) {
  if (!row) {
    return null;
  }
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const unexpired = expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > Date.now();
  const activeLease = ACTIVE_STATUSES.has(normalizeText(row.status).toLowerCase()) && unexpired;
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  return {
    ...row,
    start_command_id: normalizeText(metadata.start_command_id) || null,
    stop_command_id: normalizeText(metadata.stop_command_id) || null,
    active_lease: activeLease,
    monitoring_control_plane_only: metadata.agent_runtime_command_wired === true ? false : true,
    agent_runtime_command_wired: metadata.agent_runtime_command_wired === true
  };
}

async function expireStaleSessions(db, { companyId, deviceUid, sessionId } = {}) {
  const params = [];
  const where = [
    "status IN ('starting', 'active')",
    'expires_at <= now()'
  ];
  if (companyId) {
    params.push(companyId);
    where.push(`company_id = $${params.length}`);
  }
  if (deviceUid) {
    params.push(deviceUid);
    where.push(`device_uid = $${params.length}`);
  }
  if (sessionId) {
    params.push(sessionId);
    where.push(`id = $${params.length}::uuid`);
  }
  await db.query(
    `
    UPDATE device_monitoring_sessions
    SET status = 'expired',
        stopped_at = COALESCE(stopped_at, now()),
        stop_reason = COALESCE(stop_reason, 'lease_expired'),
        updated_at = now()
    WHERE ${where.join(' AND ')}
    `,
    params
  );
}

async function getSessionById(db, { companyId, sessionId }) {
  const safeCompanyId = normalizeText(companyId);
  const safeSessionId = normalizeText(sessionId);
  if (!safeCompanyId || !safeSessionId) {
    return { error: 'invalid_request' };
  }
  await expireStaleSessions(db, { companyId: safeCompanyId, sessionId: safeSessionId });
  const res = await db.query(
    `
    SELECT *
    FROM device_monitoring_sessions
    WHERE company_id = $1
      AND id = $2::uuid
    LIMIT 1
    `,
    [safeCompanyId, safeSessionId]
  );
  if (!res.rows[0]) {
    return { error: 'session_not_found' };
  }
  return { value: normalizeSessionRow(res.rows[0]) };
}

async function getCurrentSessionForDevice(db, { companyId, deviceUid }) {
  const safeCompanyId = normalizeText(companyId);
  const safeDeviceUid = normalizeText(deviceUid);
  if (!safeCompanyId || !safeDeviceUid) {
    return { error: 'invalid_request' };
  }
  await expireStaleSessions(db, { companyId: safeCompanyId, deviceUid: safeDeviceUid });
  const res = await db.query(
    `
    SELECT *
    FROM device_monitoring_sessions
    WHERE company_id = $1
      AND device_uid = $2
    ORDER BY
      CASE
        WHEN status IN ('starting', 'active') AND expires_at > now() THEN 0
        WHEN status = 'stopping' THEN 1
        ELSE 2
      END,
      updated_at DESC,
      created_at DESC
    LIMIT 1
    `,
    [safeCompanyId, safeDeviceUid]
  );
  return { value: normalizeSessionRow(res.rows[0]) };
}

async function validateStartContext(db, {
  companyId,
  requestedDeviceUid
}) {
  const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
    companyId,
    deviceUid: requestedDeviceUid
  });
  if (canonicalResolution.resolved_by === 'superseded_without_canonical') {
    return {
      error: 'device_uid_superseded_without_canonical',
      value: {
        requested_device_uid: canonicalResolution.requested_device_uid,
        canonical_device_uid: canonicalResolution.canonical_device_uid,
        canonical_resolved_by: canonicalResolution.resolved_by
      }
    };
  }
  const canonicalDeviceUid = normalizeText(canonicalResolution.canonical_device_uid)
    || normalizeText(canonicalResolution.requested_device_uid)
    || requestedDeviceUid;

  const deviceRes = await db.query(
    `
    SELECT company_id, device_uid, provider, managed_status, lifecycle_scope,
           manageability_status, manageability_reason, site_id, metadata
    FROM devices
    WHERE company_id = $1
      AND device_uid = $2
    LIMIT 1
    `,
    [companyId, canonicalDeviceUid]
  );
  const device = deviceRes.rows[0] || null;
  if (!device) {
    return {
      error: 'device_not_found',
      value: {
        requested_device_uid: canonicalResolution.requested_device_uid || requestedDeviceUid,
        canonical_device_uid: canonicalDeviceUid,
        canonical_resolved_by: canonicalResolution.resolved_by || 'unresolved'
      }
    };
  }
  if (normalizeText(device.managed_status).toLowerCase() !== 'managed') {
    return {
      error: 'device_not_managed',
      value: {
        requested_device_uid: canonicalResolution.requested_device_uid,
        canonical_device_uid: canonicalDeviceUid,
        managed_status: device.managed_status || null
      }
    };
  }
  if (normalizeText(device.lifecycle_scope).toLowerCase() !== 'bridge_ops') {
    return {
      error: 'device_not_bridge_scope',
      value: {
        requested_device_uid: canonicalResolution.requested_device_uid,
        canonical_device_uid: canonicalDeviceUid,
        lifecycle_scope: device.lifecycle_scope || null
      }
    };
  }
  const manageabilityStatus = normalizeText(device.manageability_status).toLowerCase();
  if (manageabilityStatus && manageabilityStatus === 'blocked') {
    return {
      error: 'device_not_manageable',
      value: {
        requested_device_uid: canonicalResolution.requested_device_uid,
        canonical_device_uid: canonicalDeviceUid,
        manageability_status: device.manageability_status || null,
        manageability_reason: device.manageability_reason || null
      }
    };
  }

  const activeBinding = await getActiveManagingAgentBinding(db, {
    companyId,
    deviceUid: canonicalDeviceUid
  });
  if (!activeBinding) {
    return {
      error: 'device_managing_agent_binding_missing',
      value: {
        requested_device_uid: canonicalResolution.requested_device_uid,
        canonical_device_uid: canonicalDeviceUid
      }
    };
  }
  const agent = await getAgentById(db, {
    companyId,
    agentId: activeBinding.agent_id
  });
  if (!agent) {
    return { error: 'agent_not_found' };
  }
  if (normalizeText(agent.status).toLowerCase() !== 'active') {
    return { error: 'agent_not_active' };
  }

  const executionGate = await evaluateCommandIssuanceGate(db, {
    companyId,
    targetAgentId: activeBinding.agent_id,
    commandType: COMMAND_TYPES.START_DEVICE_MONITORING,
    deviceUid: canonicalDeviceUid,
    deviceSiteId: device.site_id || null,
    agentSiteId: agent.site_id || null,
    bindingAgentId: activeBinding.agent_id || null
  });
  if (!executionGate.allowed) {
    return {
      error: executionGate.reason_code,
      value: {
        requested_device_uid: canonicalResolution.requested_device_uid,
        canonical_device_uid: canonicalDeviceUid,
        execution_gate: executionGate.details
      }
    };
  }

  return {
    value: {
      requested_device_uid: canonicalResolution.requested_device_uid || requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      canonical_resolved_by: canonicalResolution.resolved_by || 'direct',
      canonical_alias_kind: canonicalResolution.alias_kind || null,
      canonical_alias_status: canonicalResolution.alias_status || null,
      device,
      active_binding: activeBinding,
      agent,
      execution_gate: executionGate.details
    }
  };
}

async function startMonitoringSession(db, {
  companyId,
  deviceUid,
  rtEnabled,
  ttlSeconds,
  expiresAt,
  startedByKeyId,
  startedByRole,
  metadata
}) {
  const safeCompanyId = normalizeText(companyId);
  const requestedDeviceUid = normalizeText(deviceUid);
  if (!safeCompanyId || !requestedDeviceUid) {
    return { error: 'invalid_request' };
  }
  const context = await validateStartContext(db, {
    companyId: safeCompanyId,
    requestedDeviceUid
  });
  if (context.error) {
    return context;
  }
  const ctx = context.value;
  const leaseTtlSeconds = Math.min(Math.max(parsePositiveInt(ttlSeconds, 300), 30), 86400);
  let leaseExpiresAt = null;
  const requestedExpiresAt = normalizeText(expiresAt);
  if (requestedExpiresAt) {
    const parsed = new Date(requestedExpiresAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      return { error: 'expires_at_invalid' };
    }
    leaseExpiresAt = parsed.toISOString();
  } else {
    leaseExpiresAt = new Date(Date.now() + leaseTtlSeconds * 1000).toISOString();
  }
  const safeMetadata = isPlainObject(metadata) ? metadata : {};

  await db.query('BEGIN');
  try {
    await expireStaleSessions(db, {
      companyId: safeCompanyId,
      deviceUid: ctx.canonical_device_uid
    });
    const existingRes = await db.query(
      `
      SELECT *
      FROM device_monitoring_sessions
      WHERE company_id = $1
        AND device_uid = $2
        AND status IN ('starting', 'active')
        AND expires_at > now()
      ORDER BY started_at DESC, created_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [safeCompanyId, ctx.canonical_device_uid]
    );
    if (existingRes.rows[0]) {
      const existing = existingRes.rows[0];
      const existingMetadata = isPlainObject(existing.metadata) ? existing.metadata : {};
      if (!normalizeText(existingMetadata.start_command_id)) {
        const commandPayload = buildStartCommandPayload({
          session: existing,
          device: ctx.device,
          leaseExpiresAt: existing.expires_at
        });
        const commandRes = await db.query(
          `
          INSERT INTO agent_commands (
            company_id, agent_id, command_type, command_payload, status, created_by_key_id, expires_at
          )
          VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, $6::timestamptz)
          RETURNING id
          `,
          [
            safeCompanyId,
            ctx.active_binding.agent_id,
            COMMAND_TYPES.START_DEVICE_MONITORING,
            JSON.stringify(commandPayload),
            startedByKeyId || null,
            existing.expires_at || null
          ]
        );
        existing.metadata = {
          ...existingMetadata,
          monitoring_control_plane_only: false,
          agent_runtime_command_wired: true,
          start_command_id: commandRes.rows[0].id
        };
        await db.query(
          `
          UPDATE device_monitoring_sessions
          SET metadata = metadata || $1::jsonb,
              updated_at = now()
          WHERE company_id = $2
            AND id = $3::uuid
          `,
          [
            JSON.stringify(existing.metadata),
            safeCompanyId,
            existing.id
          ]
        );
      }
      await db.query('COMMIT');
      return {
        value: {
          ...normalizeSessionRow(existing),
          reused: true,
          requested_device_uid: ctx.requested_device_uid,
          canonical_device_uid: ctx.canonical_device_uid,
          canonical_resolved_by: ctx.canonical_resolved_by,
          canonical_alias_kind: ctx.canonical_alias_kind,
          canonical_alias_status: ctx.canonical_alias_status
        }
      };
    }

    const insertRes = await db.query(
      `
      INSERT INTO device_monitoring_sessions (
        company_id,
        device_uid,
        agent_id,
        status,
        rt_enabled,
        started_by_key_id,
        started_by_role,
        started_at,
        expires_at,
        metadata
      )
      VALUES ($1, $2, $3, 'starting', $4, $5, $6, now(), $7::timestamptz, $8::jsonb)
      RETURNING *
      `,
      [
        safeCompanyId,
        ctx.canonical_device_uid,
        ctx.active_binding.agent_id || null,
        parseBool(rtEnabled, true),
        startedByKeyId || null,
        startedByRole || null,
        leaseExpiresAt,
        JSON.stringify({
          ...safeMetadata,
          requested_device_uid: ctx.requested_device_uid,
          canonical_resolved_by: ctx.canonical_resolved_by,
          canonical_alias_kind: ctx.canonical_alias_kind,
          canonical_alias_status: ctx.canonical_alias_status,
          monitoring_control_plane_only: true,
          agent_runtime_command_wired: false,
          execution_gate: ctx.execution_gate
        })
      ]
    );
    const insertedSession = insertRes.rows[0];
    const commandPayload = buildStartCommandPayload({
      session: insertedSession,
      device: ctx.device,
      leaseExpiresAt
    });
    const commandRes = await db.query(
      `
      INSERT INTO agent_commands (
        company_id, agent_id, command_type, command_payload, status, created_by_key_id, expires_at
      )
      VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, $6::timestamptz)
      RETURNING id
      `,
      [
        safeCompanyId,
        ctx.active_binding.agent_id,
        COMMAND_TYPES.START_DEVICE_MONITORING,
        JSON.stringify(commandPayload),
        startedByKeyId || null,
        leaseExpiresAt
      ]
    );
    const wiredMetadata = {
      monitoring_control_plane_only: false,
      agent_runtime_command_wired: true,
      start_command_id: commandRes.rows[0].id
    };
    const wiredRes = await db.query(
      `
      UPDATE device_monitoring_sessions
      SET metadata = metadata || $1::jsonb,
          updated_at = now()
      WHERE company_id = $2
        AND id = $3::uuid
      RETURNING *
      `,
      [JSON.stringify(wiredMetadata), safeCompanyId, insertedSession.id]
    );
    await db.query('COMMIT');
    return {
      value: {
        ...normalizeSessionRow(wiredRes.rows[0]),
        reused: false,
        requested_device_uid: ctx.requested_device_uid,
        canonical_device_uid: ctx.canonical_device_uid,
        canonical_resolved_by: ctx.canonical_resolved_by,
        canonical_alias_kind: ctx.canonical_alias_kind,
        canonical_alias_status: ctx.canonical_alias_status
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function stopMonitoringSession(db, {
  companyId,
  sessionId,
  stopReason
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeSessionId = normalizeText(sessionId);
  if (!safeCompanyId || !safeSessionId) {
    return { error: 'invalid_request' };
  }
  await db.query('BEGIN');
  try {
    await expireStaleSessions(db, { companyId: safeCompanyId, sessionId: safeSessionId });
    const currentRes = await db.query(
      `
      SELECT *
      FROM device_monitoring_sessions
      WHERE company_id = $1
        AND id = $2::uuid
      LIMIT 1
      FOR UPDATE
      `,
      [safeCompanyId, safeSessionId]
    );
    const current = currentRes.rows[0] || null;
    if (!current) {
      await db.query('ROLLBACK');
      return { error: 'session_not_found' };
    }
    if (normalizeText(current.status).toLowerCase() === 'expired') {
      await db.query('COMMIT');
      return { value: normalizeSessionRow(current) };
    }
    const currentStatus = normalizeText(current.status).toLowerCase();
    if (TERMINAL_STATUSES.has(currentStatus)) {
      await db.query('COMMIT');
      return { value: normalizeSessionRow(current) };
    }
    const currentMetadata = isPlainObject(current.metadata) ? current.metadata : {};
    let stopCommandId = normalizeText(currentMetadata.stop_command_id) || null;
    if (!stopCommandId && normalizeText(current.agent_id)) {
      const commandPayload = buildStopCommandPayload({
        session: current,
        reason: stopReason
      });
      const commandRes = await db.query(
        `
        INSERT INTO agent_commands (
          company_id, agent_id, command_type, command_payload, status, created_by_key_id, expires_at
        )
        VALUES ($1, $2, $3, $4::jsonb, 'queued', NULL, now() + interval '60 seconds')
        RETURNING id
        `,
        [
          safeCompanyId,
          current.agent_id,
          COMMAND_TYPES.STOP_DEVICE_MONITORING,
          JSON.stringify(commandPayload)
        ]
      );
      stopCommandId = commandRes.rows[0].id;
    }
    const updatedRes = await db.query(
      `
      UPDATE device_monitoring_sessions
      SET status = 'stopping',
          stop_reason = $3,
          updated_at = now(),
          metadata = metadata || $4::jsonb
      WHERE company_id = $1
        AND id = $2::uuid
      RETURNING *
      `,
      [
        safeCompanyId,
        safeSessionId,
        normalizeText(stopReason) || 'operator_stop',
        JSON.stringify({
          monitoring_control_plane_only: false,
          agent_runtime_command_wired: true,
          stop_command_id: stopCommandId
        })
      ]
    );
    await db.query('COMMIT');
    return { value: normalizeSessionRow(updatedRes.rows[0]) };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function ingestMonitoringCommandResult(db, {
  companyId,
  agentId,
  payload
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeAgentId = normalizeText(agentId);
  const safePayload = isPlainObject(payload) ? payload : {};
  const commandId = normalizeText(safePayload.command_id);
  const sessionId = normalizeText(safePayload.monitoring_session_id);
  const deviceUid = normalizeText(safePayload.device_uid);
  const runtimeState = normalizeText(safePayload.runtime_monitoring_state).toLowerCase();
  const ok = safePayload.ok === true;
  if (!safeCompanyId || !safeAgentId || !commandId || !sessionId || !deviceUid) {
    return { error: 'invalid_request' };
  }

  await db.query('BEGIN');
  try {
    const commandRes = await db.query(
      `
      SELECT id, command_type, command_payload, status
      FROM agent_commands
      WHERE company_id = $1
        AND agent_id = $2
        AND id = $3::uuid
        AND command_type IN ($4, $5)
      LIMIT 1
      FOR UPDATE
      `,
      [
        safeCompanyId,
        safeAgentId,
        commandId,
        COMMAND_TYPES.START_DEVICE_MONITORING,
        COMMAND_TYPES.STOP_DEVICE_MONITORING
      ]
    );
    const command = commandRes.rows[0] || null;
    if (!command) {
      await db.query('ROLLBACK');
      return { error: 'monitoring_command_not_found' };
    }
    const commandPayload = isPlainObject(command.command_payload) ? command.command_payload : {};
    const commandSessionId = normalizeText(commandPayload.monitoring_session_id);
    const commandDeviceUid = normalizeText(commandPayload.device_uid);
    if (commandSessionId !== sessionId || commandDeviceUid !== deviceUid) {
      await db.query('ROLLBACK');
      return { error: 'monitoring_command_payload_mismatch' };
    }

    const sessionRes = await db.query(
      `
      SELECT *
      FROM device_monitoring_sessions
      WHERE company_id = $1
        AND id = $2::uuid
        AND device_uid = $3
      LIMIT 1
      FOR UPDATE
      `,
      [safeCompanyId, sessionId, deviceUid]
    );
    const session = sessionRes.rows[0] || null;
    if (!session) {
      await db.query('ROLLBACK');
      return { error: 'session_not_found' };
    }

    const resultPayload = {
      monitoring_command_result: {
        command_id: commandId,
        monitoring_session_id: sessionId,
        device_uid: deviceUid,
        ok,
        runtime_monitoring_state: runtimeState || null,
        rt_subscriber_started: safePayload.rt_subscriber_started === true,
        rt_subscriber_already_running: safePayload.rt_subscriber_already_running === true,
        rt_subscriber_stopped: safePayload.rt_subscriber_stopped === true,
        diagnostics: isPlainObject(safePayload.diagnostics) ? safePayload.diagnostics : {}
      }
    };

    if (ok) {
      await db.query(
        `
        UPDATE agent_commands
        SET status = 'acknowledged',
            acknowledged_at = now(),
            result_payload = COALESCE(result_payload, '{}'::jsonb) || $1::jsonb
        WHERE company_id = $2
          AND agent_id = $3
          AND id = $4::uuid
        `,
        [JSON.stringify(resultPayload), safeCompanyId, safeAgentId, commandId]
      );
      if (command.command_type === COMMAND_TYPES.START_DEVICE_MONITORING) {
        const updated = await db.query(
          `
          UPDATE device_monitoring_sessions
          SET status = 'active',
              last_heartbeat_at = now(),
              metadata = metadata || $1::jsonb,
              updated_at = now()
          WHERE company_id = $2
            AND id = $3::uuid
          RETURNING *
          `,
          [
            JSON.stringify({
              runtime_state: 'active',
              runtime_state_updated_at: new Date().toISOString(),
              last_start_result: resultPayload.monitoring_command_result
            }),
            safeCompanyId,
            sessionId
          ]
        );
        await db.query('COMMIT');
        return { value: normalizeSessionRow(updated.rows[0]) };
      }

      const updated = await db.query(
        `
        UPDATE device_monitoring_sessions
        SET status = 'stopped',
            stopped_at = COALESCE(stopped_at, now()),
            stop_reason = COALESCE($1, stop_reason, 'operator_stop'),
            metadata = metadata || $2::jsonb,
            updated_at = now()
        WHERE company_id = $3
          AND id = $4::uuid
        RETURNING *
        `,
        [
          normalizeText(safePayload.stop_reason) || normalizeText(commandPayload.reason) || null,
          JSON.stringify({
            runtime_state: 'stopped',
            runtime_state_updated_at: new Date().toISOString(),
            last_stop_result: resultPayload.monitoring_command_result
          }),
          safeCompanyId,
          sessionId
        ]
      );
      await db.query('COMMIT');
      return { value: normalizeSessionRow(updated.rows[0]) };
    }

    const failureReason = normalizeText(safePayload.reason_code)
      || normalizeText(safePayload.error)
      || 'monitoring_command_failed';
    await db.query(
      `
      UPDATE agent_commands
      SET status = 'failed',
          failure_reason = $1,
          result_payload = COALESCE(result_payload, '{}'::jsonb) || $2::jsonb
      WHERE company_id = $3
        AND agent_id = $4
        AND id = $5::uuid
      `,
      [failureReason, JSON.stringify(resultPayload), safeCompanyId, safeAgentId, commandId]
    );
    const updated = await db.query(
      `
      UPDATE device_monitoring_sessions
      SET status = 'failed',
          metadata = metadata || $1::jsonb,
          updated_at = now()
      WHERE company_id = $2
        AND id = $3::uuid
      RETURNING *
      `,
      [
        JSON.stringify({
          runtime_state: 'failed',
          runtime_state_updated_at: new Date().toISOString(),
          runtime_failure_reason: failureReason,
          last_failure_result: resultPayload.monitoring_command_result
        }),
        safeCompanyId,
        sessionId
      ]
    );
    await db.query('COMMIT');
    return { value: normalizeSessionRow(updated.rows[0]) };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  startMonitoringSession,
  getCurrentSessionForDevice,
  getSessionById,
  stopMonitoringSession,
  ingestMonitoringCommandResult,
  expireStaleSessions,
  __test: {
    normalizeSessionRow
  }
};
