const express = require('express');
const router = express.Router();

const db = require('../db');
const { sendError } = require('./lib/errorEnvelope');
const { requireAgentAuth } = require('../services/agentAuth');
const {
  bootstrapAgent,
  updateHeartbeat,
  fetchNextCommandForAgent,
  ingestDiscoveryReport,
  ingestDeviceValidationResult,
  ingestK80EnrollmentAttemptResult
} = require('../services/agentBridgeDb');
const { ingestAgentEventBatch } = require('../services/agentDeviceEventsService');
const { ingestDevicePathPullCapabilityProbeResult } = require('../services/agentDeviceEventsService');
const { ingestMonitoringCommandResult } = require('../services/deviceMonitoringSessionsService');
const {
  validateDiscoveryReportPayload,
  validateAgentDeviceValidationResultPayload,
  validateAgentEnrollmentAttemptResultPayload
} = require('../contracts/agentBridgeContract');
const { validateAgentEventBatchPayload } = require('../contracts/agentDeviceEventsContract');
const { emitAuditEvent } = require('../services/auditLogger');
const { logBridgeEvent } = require('../services/bridgeLogger');
const { RUNTIME_SCHEMA_NOT_READY_CODE } = require('../services/reportedStateDb');

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isRuntimeSchemaNotReadyError(err) {
  return Boolean(err && err.code === RUNTIME_SCHEMA_NOT_READY_CODE);
}

function sendRuntimeSchemaNotReadyError(res, err, endpoint) {
  const details = err && err.details && typeof err.details === 'object' ? err.details : {};
  return sendError(res, {
    status: 503,
    code: RUNTIME_SCHEMA_NOT_READY_CODE,
    message: 'Runtime schema is not ready',
    error: 'runtime_schema_not_ready',
    details: {
      kind: 'runtime_integrity',
      error: 'runtime_schema_not_ready',
      endpoint,
      ...details
    }
  });
}

router.post('/bootstrap', async (req, res) => {
  try {
    const body = req.body || {};
    const provisioningToken = normalizeText(body.provisioning_token);
    const agentName = normalizeText(body.agent_name);
    logBridgeEvent('bridge.api.agent.bootstrap.requested', {
      agent_name: agentName || null
    });
    if (!provisioningToken) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'provisioning_token is required'
        }
      });
    }
    if (!agentName) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'agent_name is required'
        }
      });
    }

    const result = await bootstrapAgent(db, {
      provisioningToken,
      agentName,
      metadata: body.metadata
    });
    if (result.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: result.error
        }
      });
    }

    const created = result.value;
    logBridgeEvent('bridge.api.agent.bootstrap.succeeded', {
      company_id: created.company_id,
      agent_id: created.id,
      agent_name: created.agent_name,
      credential_version: created.credential_version,
      active_runtime_identity_id: created.active_runtime_identity_id || null,
      identity_status: created.identity_status || null
    });
    return res.status(201).json({
      agent_id: created.id,
      company_id: created.company_id,
      agent_name: created.agent_name,
      credential_version: created.credential_version,
      active_runtime_identity_id: created.active_runtime_identity_id || null,
      identity_status: created.identity_status || null,
      runtime_identity_issued_at: created.runtime_identity_issued_at || null,
      auth_token: created.auth_token,
      registered_at: created.registered_at
    });
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/heartbeat', requireAgentAuth, async (req, res) => {
  try {
    logBridgeEvent('bridge.api.agent.heartbeat.requested', {
      company_id: req.agent.company_id,
      agent_id: req.agent.id
    });
    const updated = await updateHeartbeat(db, {
      agentId: req.agent.id,
      companyId: req.agent.company_id,
      payload: req.body
    });
    if (!updated) {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Agent not found',
        details: {
          kind: 'lookup_error',
          error: 'agent_not_found'
        }
      });
    }
    logBridgeEvent('bridge.api.agent.heartbeat.succeeded', {
      company_id: updated.company_id,
      agent_id: updated.id,
      last_heartbeat_at: updated.last_heartbeat_at
    });
    return res.json({
      status: 'ok',
      agent_id: updated.id,
      company_id: updated.company_id,
      last_heartbeat_at: updated.last_heartbeat_at
    });
  } catch (err) {
    if (isRuntimeSchemaNotReadyError(err)) {
      return sendRuntimeSchemaNotReadyError(res, err, '/api/agent/heartbeat');
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/commands/next', requireAgentAuth, async (req, res) => {
  try {
    logBridgeEvent('bridge.api.agent.commands.next.requested', {
      company_id: req.agent.company_id,
      agent_id: req.agent.id
    });
    const command = await fetchNextCommandForAgent(db, {
      companyId: req.agent.company_id,
      agentId: req.agent.id
    });

    logBridgeEvent('bridge.api.agent.commands.next.responded', {
      company_id: req.agent.company_id,
      agent_id: req.agent.id,
      command_id: command ? command.id : null,
      command_type: command ? command.command_type : null
    });

    return res.json({
      command: command ? {
        id: command.id,
        type: command.command_type,
        payload: command.command_payload,
        created_at: command.created_at
      } : null
    });
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/monitoring-command-results', requireAgentAuth, async (req, res) => {
  try {
    const result = await ingestMonitoringCommandResult(db, {
      companyId: req.agent.company_id,
      agentId: req.agent.id,
      payload: req.body || {}
    });
    if (result.error) {
      return sendError(res, {
        status: result.error === 'monitoring_command_not_found' || result.error === 'session_not_found' ? 404 : 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: result.error
        }
      });
    }
    return res.json(result.value);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/discovery-reports', requireAgentAuth, async (req, res) => {
  try {
    const validated = validateDiscoveryReportPayload(req.body || {});
    if (!validated.ok) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: validated.error
        }
      });
    }
    const payload = validated.value;
    const runId = payload.summary && typeof payload.summary === 'object'
      ? normalizeText(payload.summary.run_id) || null
      : null;
    logBridgeEvent('bridge.api.agent.discovery_report.requested', {
      company_id: req.agent.company_id,
      agent_id: req.agent.id,
      command_id: payload.command_id,
      run_id: runId,
      adapter_id: payload.adapter_id,
      discovered_devices_count: payload.discovered_devices.length
    });

    const report = await ingestDiscoveryReport(db, {
      companyId: req.agent.company_id,
      agentId: req.agent.id,
      commandId: payload.command_id,
      adapterId: payload.adapter_id,
      subnetTargets: payload.subnet_targets,
      reportedAt: payload.reported_at,
      discoveredDevices: payload.discovered_devices,
      summary: payload.summary
    });

    emitAuditEvent({
      actor_key_id: `agent:${req.agent.id}`,
      company_id: req.agent.company_id,
      role: 'agent',
      action: 'agent.discovery.report',
      target: req.originalUrl || req.path,
      metadata: {
        agent_id: req.agent.id,
        report_id: report.id,
        discovered_devices_count: payload.discovered_devices.length
      }
    });

    logBridgeEvent('bridge.api.agent.discovery_report.succeeded', {
      company_id: req.agent.company_id,
      agent_id: req.agent.id,
      command_id: payload.command_id,
      run_id: runId,
      report_id: report.id,
      discovered_devices_count: payload.discovered_devices.length
    });

    return res.status(201).json({
      status: 'ok',
      report_id: report.id
    });
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/device-validations/result', requireAgentAuth, async (req, res) => {
  try {
    const validated = validateAgentDeviceValidationResultPayload(req.body || {});
    if (!validated.ok) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: validated.error
        }
      });
    }
    const payload = validated.value;

    logBridgeEvent('bridge.api.agent.device_validation_result.requested', {
      company_id: req.agent.company_id,
      agent_id: req.agent.id,
      command_id: payload.command_id,
      requested_device_uid: payload.device_uid,
      result_success: payload.result.success === true,
      result_reason_code: payload.result.reason_code || null
    });

    const result = await ingestDeviceValidationResult(db, {
      companyId: req.agent.company_id,
      agentId: req.agent.id,
      payload
    });

    if (result.error) {
      const notFoundErrors = new Set(['validation_command_not_found']);
      const conflictErrors = new Set([
        'validation_command_not_pending',
        'validation_device_uid_mismatch',
        'device_uid_superseded_without_canonical'
      ]);
      return sendError(res, {
        status: notFoundErrors.has(result.error) ? 404 : (conflictErrors.has(result.error) ? 409 : 400),
        code: notFoundErrors.has(result.error)
          ? 'LOOKUP_NOT_FOUND'
          : (conflictErrors.has(result.error) ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: notFoundErrors.has(result.error)
          ? 'Not found'
          : (conflictErrors.has(result.error) ? 'Conflict' : 'Validation failed'),
        details: {
          kind: notFoundErrors.has(result.error)
            ? 'lookup_error'
            : (conflictErrors.has(result.error) ? 'conflict' : 'validation'),
          error: result.error,
          ...(result.value ? result.value : {})
        }
      });
    }

    const value = result.value || {};
    emitAuditEvent({
      actor_key_id: `agent:${req.agent.id}`,
      company_id: req.agent.company_id,
      role: 'agent',
      action: 'agent.device.validation.result',
      target: req.originalUrl || req.path,
      metadata: {
        agent_id: req.agent.id,
        command_id: value.command_id || payload.command_id,
        requested_device_uid: value.requested_device_uid || payload.device_uid,
        canonical_device_uid: value.canonical_device_uid || null,
        result_success: value.result ? value.result.success === true : payload.result.success === true,
        result_reason_code: value.result ? value.result.reason_code : payload.result.reason_code
      }
    });

    logBridgeEvent('bridge.api.agent.device_validation_result.succeeded', {
      company_id: req.agent.company_id,
      agent_id: req.agent.id,
      command_id: value.command_id || payload.command_id,
      requested_device_uid: value.requested_device_uid || payload.device_uid,
      canonical_device_uid: value.canonical_device_uid || null,
      canonical_resolved_by: value.canonical_resolved_by || null,
      validation_status: value.validation_status || null,
      result_success: value.result ? value.result.success === true : payload.result.success === true,
      result_reason_code: value.result ? value.result.reason_code : payload.result.reason_code
    });

    return res.status(201).json({
      status: 'ok',
      ...value
    });
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/device-path-pull-capability-probes/result', requireAgentAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const commandId = normalizeText(payload.command_id);
    const deviceUid = normalizeText(payload.device_uid);
    if (!commandId || !deviceUid || !payload.result || typeof payload.result !== 'object') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'command_id, device_uid, and result are required'
        }
      });
    }

    logBridgeEvent('bridge.api.agent.device_path_pull_capability_probe_result.requested', {
      company_id: req.agent.company_id,
      agent_id: req.agent.id,
      command_id: commandId,
      device_uid: deviceUid,
      result_success: payload.result.success === true,
      result_reason_code: payload.result.reason_code || null
    });

    const result = await ingestDevicePathPullCapabilityProbeResult(db, {
      companyId: req.agent.company_id,
      agentId: req.agent.id,
      payload
    });

    if (result.error) {
      const notFoundErrors = new Set(['probe_command_not_found']);
      const conflictErrors = new Set(['probe_device_uid_mismatch']);
      return sendError(res, {
        status: notFoundErrors.has(result.error) ? 404 : (conflictErrors.has(result.error) ? 409 : 400),
        code: notFoundErrors.has(result.error)
          ? 'LOOKUP_NOT_FOUND'
          : (conflictErrors.has(result.error) ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: notFoundErrors.has(result.error)
          ? 'Not found'
          : (conflictErrors.has(result.error) ? 'Conflict' : 'Validation failed'),
        details: {
          kind: notFoundErrors.has(result.error)
            ? 'lookup_error'
            : (conflictErrors.has(result.error) ? 'conflict' : 'validation'),
          error: result.error,
          ...(result.value ? result.value : {})
        }
      });
    }

    return res.status(201).json({
      status: 'ok',
      ...result.value
    });
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/enrollment-attempts/result', requireAgentAuth, async (req, res) => {
  try {
    const validated = validateAgentEnrollmentAttemptResultPayload(req.body || {});
    if (!validated.ok) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: validated.error
        }
      });
    }
    const payload = validated.value;
    const result = await ingestK80EnrollmentAttemptResult(db, {
      companyId: req.agent.company_id,
      agentId: req.agent.id,
      payload
    });
    if (result.error) {
      const notFoundErrors = new Set(['enrollment_command_not_found', 'enrollment_attempt_not_found']);
      const conflictErrors = new Set([
        'enrollment_command_not_pending',
        'enrollment_attempt_mismatch',
        'enrollment_device_uid_mismatch',
        'device_uid_superseded_without_canonical'
      ]);
      return sendError(res, {
        status: notFoundErrors.has(result.error) ? 404 : (conflictErrors.has(result.error) ? 409 : 400),
        code: notFoundErrors.has(result.error)
          ? 'LOOKUP_NOT_FOUND'
          : (conflictErrors.has(result.error) ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: notFoundErrors.has(result.error)
          ? 'Not found'
          : (conflictErrors.has(result.error) ? 'Conflict' : 'Validation failed'),
        details: {
          kind: notFoundErrors.has(result.error)
            ? 'lookup_error'
            : (conflictErrors.has(result.error) ? 'conflict' : 'validation'),
          error: result.error,
          ...(result.value ? result.value : {})
        }
      });
    }

    emitAuditEvent({
      actor_key_id: `agent:${req.agent.id}`,
      company_id: req.agent.company_id,
      role: 'agent',
      action: 'agent.enrollment_attempt.result',
      target: req.originalUrl || req.path,
      metadata: {
        agent_id: req.agent.id,
        command_id: payload.command_id,
        enrollment_attempt_id: payload.enrollment_attempt_id,
        requested_device_uid: payload.device_uid,
        attempt_status: payload.result.attempt_status,
        status_reason: payload.result.status_reason || null
      }
    });

    return res.status(201).json({
      status: 'ok',
      ...result.value
    });
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/device-events/batch', requireAgentAuth, async (req, res) => {
  try {
    const validated = validateAgentEventBatchPayload(req.body || {});
    if (!validated.ok) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: validated.error
        }
      });
    }
    const payload = validated.value;

    logBridgeEvent('bridge.api.agent.device_events_batch.requested', {
      company_id: req.agent.company_id,
      agent_id: req.agent.id,
      command_id: payload.command_id,
      run_id: payload.run_id,
      device_uid: payload.device_uid,
      events_count: payload.events.length
    });

    const ingestResult = await ingestAgentEventBatch(db, {
      companyId: req.agent.company_id,
      agentId: req.agent.id,
      payload
    });

    if (ingestResult.error) {
      const notFound = ingestResult.error === 'device_not_found';
      return sendError(res, {
        status: notFound ? 404 : 400,
        code: notFound ? 'LOOKUP_NOT_FOUND' : 'VALIDATION_ERROR',
        message: notFound ? 'Not found' : 'Validation failed',
        details: {
          kind: notFound ? 'lookup_error' : 'validation',
          error: ingestResult.error
        }
      });
    }

    emitAuditEvent({
      actor_key_id: `agent:${req.agent.id}`,
      company_id: req.agent.company_id,
      role: 'agent',
      action: 'agent.device_events.batch',
      target: req.originalUrl || req.path,
      metadata: {
        agent_id: req.agent.id,
        command_id: payload.command_id,
        device_uid: payload.device_uid,
        batch_id: ingestResult.value.batch_id,
        inserted_count: ingestResult.value.inserted_count,
        deduped_count: ingestResult.value.deduped_count,
        rejected_count: ingestResult.value.rejected_count
      }
    });

    logBridgeEvent('bridge.api.agent.device_events_batch.succeeded', {
      company_id: req.agent.company_id,
      agent_id: req.agent.id,
      command_id: payload.command_id,
      run_id: payload.run_id,
      device_uid: payload.device_uid,
      batch_id: ingestResult.value.batch_id,
      inserted_count: ingestResult.value.inserted_count,
      deduped_count: ingestResult.value.deduped_count,
      rejected_count: ingestResult.value.rejected_count
    });

    return res.status(201).json({
      status: 'ok',
      ...ingestResult.value
    });
  } catch (err) {
    if (isRuntimeSchemaNotReadyError(err)) {
      return sendRuntimeSchemaNotReadyError(res, err, '/api/agent/device-events/batch');
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

module.exports = router;
