const express = require('express');
const router = express.Router();

const db = require('../db');
const { emitAuditEvent } = require('../services/auditLogger');
const {
  createProvisioningToken,
  queueScanSubnetCommand,
  queueValidateDeviceCandidateCommand,
  queueK80EnrollmentAttemptExecutionCommand,
  listAgentCommands,
  listAgents,
  getLifecycleIntegrityReport,
  getLifecycleReconciliationDryRun,
  executeLifecycleReconciliationRepair,
  listCandidateDevices,
  getDeviceOnboardingReadiness,
  upsertManualOnboardingCandidate,
  claimCandidateDevice,
  setManagingAgentBinding,
  reconcileAgentCommandLifecycle,
  setManualDeviceRemediation,
  getAgentById,
  getAgentVersionPolicy,
  setCompanyVersionPolicy,
  resolveCanonicalDeviceUidForOperations,
  getAgentRuntimeIdentity,
  reissueAgentRuntimeIdentity,
  revokeAgentRuntimeIdentity
} = require('../services/agentBridgeDb');
const {
  PULL_COMMAND_INFLIGHT_ERROR,
  queuePullDeviceEventsCommand,
  queueDevicePathPullCapabilityRefreshCommand,
  listDeviceSyncStates,
  listDeviceEventBatches,
  listRecentDeviceEvents
} = require('../services/agentDeviceEventsService');
const { EXECUTION_GATE_REASON_CODES } = require('../services/executionGating');
const { requireApiKey, requireRole, enforceCompanyScope } = require('./lib/auth');
const { sendError } = require('./lib/errorEnvelope');
const {
  validateScanSubnetCommandPayload,
  validateManualDeviceOnboardingPayload,
  validateManualDeviceValidationRequestPayload,
  validateAgentVersionPolicyPayload
} = require('../contracts/agentBridgeContract');
const { validatePullDeviceEventsCommandPayload } = require('../contracts/agentDeviceEventsContract');
const {
  validateInventorySnapshotCreatePayload,
  validateEnrollmentPreflightPayload
} = require('../contracts/deviceUserInventoryContract');
const { validateEnrollmentAttemptStartPayload } = require('../contracts/k80EnrollmentOrchestrationContract');
const { logBridgeEvent } = require('../services/bridgeLogger');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  attachManageabilityView,
  MANUAL_REMEDIATION_STATUS
} = require('../services/deviceManageability');
const {
  normalizeUuidOrNull,
  listSites,
  getSiteById,
  createSite,
  updateSite,
  setAgentSiteAssignment,
  setDeviceSiteAssignment,
  getSiteActiveAgentLease,
  listSiteAgentLeaseHistory,
  setSiteActiveAgentLease
} = require('../services/sitesDb');
const {
  INVENTORY_SCOPE,
  INVENTORY_CANDIDATE_STRATEGY,
  INVENTORY_CANDIDATE_STATUS,
  ENROLLMENT_PREFLIGHT_SELECTED_SOURCE,
  ENROLLMENT_PREFLIGHT_STATUS,
  computeConservativeNextCandidateFromSnapshot,
  evaluateEnrollmentPreflight,
  createDeviceUserInventorySnapshot,
  getLatestDeviceUserInventorySnapshot,
  createEnrollmentPreflightDecision
} = require('../services/deviceUserInventoryService');
const {
  getLatestEnrollmentPreflightDecision,
  getEnrollmentPreflightDecisionById,
  validatePreflightForEnrollmentStart,
  createEnrollmentAttempt,
  getEnrollmentAttemptById
} = require('../services/deviceEnrollmentOrchestrationService');
const {
  startMonitoringSession,
  getCurrentSessionForDevice,
  getSessionById,
  stopMonitoringSession
} = require('../services/deviceMonitoringSessionsService');
const {
  listRealtimeObservations
} = require('../services/realtimeObservationsService');

function parseLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return 50;
  }
  return Math.min(parsed, 200);
}

function parseOffset(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function parseIsoDateTime(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { value: null };
  }
  const raw = value.trim();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { error: 'must be a valid ISO date-time' };
  }
  return { value: parsed.toISOString() };
}

function parseBooleanFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return { value: defaultValue };
  }
  if (typeof value === 'boolean') {
    return { value };
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return { value: true };
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return { value: false };
  }
  return { error: 'must be a boolean (true/false/1/0)' };
}

function parseMonitoringTtlSeconds(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return 300;
  }
  return Math.min(Math.max(parsed, 30), 86400);
}

function sendMonitoringServiceError(res, result) {
  const error = result && result.error ? result.error : 'invalid_request';
  const notFoundErrors = new Set(['device_not_found', 'agent_not_found', 'session_not_found']);
  const conflictErrors = new Set([
    'device_uid_superseded_without_canonical',
    'device_not_managed',
    'device_not_bridge_scope',
    'device_not_manageable',
    'device_managing_agent_binding_missing',
    'agent_not_active',
    'site_active_runtime_mismatch',
    'site_active_runtime_missing',
    'device_binding_site_runtime_conflict',
    'runtime_reported_state_missing',
    'runtime_reported_state_stale',
    'runtime_health_offline',
    'runtime_health_blocked',
    'runtime_health_unknown',
    'runtime_version_unsupported',
    'runtime_version_unknown',
    'runtime_version_outdated',
    'runtime_capability_unsupported',
    'runtime_capability_disabled',
    'runtime_capability_unknown',
    'device_path_capability_unsupported',
    'device_path_capability_disabled',
    'device_path_capability_unknown'
  ]);
  return sendError(res, {
    status: notFoundErrors.has(error) ? 404 : (conflictErrors.has(error) ? 409 : 400),
    code: notFoundErrors.has(error)
      ? 'LOOKUP_NOT_FOUND'
      : (conflictErrors.has(error) ? 'CONFLICT' : 'VALIDATION_ERROR'),
    message: notFoundErrors.has(error)
      ? 'Not found'
      : (conflictErrors.has(error) ? 'Conflict' : 'Validation failed'),
    details: {
      kind: notFoundErrors.has(error)
        ? 'lookup_error'
        : (conflictErrors.has(error) ? 'conflict' : 'validation'),
      error,
      ...(result && result.value ? result.value : {})
    }
  });
}

function parseInventoryScope(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) {
    return { value: INVENTORY_SCOPE.ZK_K80 };
  }
  if (normalized !== INVENTORY_SCOPE.ZK_K80) {
    return { error: `inventory_scope must be ${INVENTORY_SCOPE.ZK_K80}` };
  }
  return { value: normalized };
}

function resolveCompanyId(req, body) {
  if (req.ctx && req.ctx.company_id) {
    return { value: req.ctx.company_id };
  }
  const bodyId = body && typeof body.company_id === 'string' ? body.company_id : null;
  const queryId = req.query && typeof req.query.company_id === 'string' ? req.query.company_id : null;
  const headerId = typeof req.get('x-company-id') === 'string' ? req.get('x-company-id') : null;

  if (bodyId && ((queryId && bodyId !== queryId) || (headerId && bodyId !== headerId))) {
    return { error: 'company_id mismatch' };
  }
  return { value: bodyId || queryId || headerId || 'DEFAULT' };
}

router.post('/provisioning-tokens', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const ttlMinutes = Number.isInteger(body.ttl_minutes) ? body.ttl_minutes : 60;
    const metadata = (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata))
      ? body.metadata
      : {};
    const created = await createProvisioningToken(db, {
      companyId,
      createdByKeyId: req.ctx ? req.ctx.key_id_or_prefix : null,
      ttlMinutes,
      metadata
    });
    logBridgeEvent('bridge.api.admin.provisioning_token.created', {
      company_id: companyId,
      token_id: created.id,
      token_prefix: created.token_prefix,
      expires_at: created.expires_at
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.provisioning_token.create',
      target: req.originalUrl || req.path,
      metadata: {
        token_id: created.id,
        token_prefix: created.token_prefix,
        expires_at: created.expires_at
      }
    });

    return res.status(201).json({
      id: created.id,
      company_id: created.company_id,
      provisioning_token: created.token,
      token_prefix: created.token_prefix,
      expires_at: created.expires_at,
      created_at: created.created_at
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

router.post('/agents/:agentId/commands/scan-subnet', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const agentId = req.params.agentId;
    const agent = await getAgentById(db, { companyId, agentId });
    if (!agent) {
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

    const validated = validateScanSubnetCommandPayload(body);
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

    const command = await queueScanSubnetCommand(db, {
      companyId,
      agentId,
      commandPayload: validated.value,
      createdByKeyId: req.ctx ? req.ctx.key_id_or_prefix : null
    });
    logBridgeEvent('bridge.api.admin.command.scan_subnet.queued', {
      company_id: companyId,
      agent_id: agentId,
      command_id: command.id,
      subnet_targets: validated.value.subnet_targets
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.command.scan_subnet',
      target: req.originalUrl || req.path,
      metadata: {
        agent_id: agentId,
        command_id: command.id,
        subnet_targets: validated.value.subnet_targets
      }
    });

    return res.status(201).json(command);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/agents/:agentId/commands/pull-device-events', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const body = req.body || {};
    const traceToken = crypto.randomUUID();
    let requestCapture = null;
    try {
      const options = (body && typeof body.options === 'object' && !Array.isArray(body.options)) ? body.options : {};
      const capture = {
        ts: new Date().toISOString(),
        route: '/api/agent-admin/agents/:agentId/commands/pull-device-events',
        agent_id: req.params.agentId || null,
        company_id: (req.ctx && req.ctx.company_id) || body.company_id || null,
        device_uid: body.device_uid || null,
        options: {
          history_mode: options.history_mode || null,
          history_before_utc: options.history_before_utc || null,
          history_before_dedup_key: options.history_before_dedup_key || null,
          since_utc: options.since_utc || null,
          max_events: Number.isInteger(options.max_events) ? options.max_events : null,
          lookback_minutes: Number.isInteger(options.lookback_minutes) ? options.lookback_minutes : null,
          safety_window_minutes: Number.isInteger(options.safety_window_minutes) ? options.safety_window_minutes : null,
          sent_stale_seconds: Number.isInteger(options.sent_stale_seconds) ? options.sent_stale_seconds : null,
          device_timezone: options.device_timezone || null
        },
        raw_options_keys: Object.keys(options || {}).sort()
      };
      const capturePath = path.join(__dirname, '..', 'logs', 'pull-device-events-request.log');
      fs.appendFileSync(capturePath, `${JSON.stringify(capture)}\n`);
      requestCapture = capture;
    } catch (err) {
      console.warn('pull-device-events request capture failed', err);
    }
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const validated = validatePullDeviceEventsCommandPayload(body);
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

    const companyId = resolved.value;
    const agentId = req.params.agentId;
    try {
      const capturePath = path.join(__dirname, '..', 'logs', 'pull-device-events-options-trace.log');
      fs.appendFileSync(capturePath, `${JSON.stringify({
        ts: new Date().toISOString(),
        trace_token: traceToken,
        stage: 'route_validated_options',
        agent_id: agentId,
        device_uid: validated.value.device_uid,
        options: validated.value.options || {}
      })}\n`);
    } catch (err) {
      console.warn('pull-device-events options trace failed (route)', err);
    }
    const result = await queuePullDeviceEventsCommand(db, {
      companyId,
      agentId,
      deviceUid: validated.value.device_uid,
      options: validated.value.options,
      createdByKeyId: req.ctx ? req.ctx.key_id_or_prefix : null,
      traceToken
    });

    if (result.error) {
      const notFoundErrors = new Set(['agent_not_found', 'device_not_found']);
      const conflictErrors = new Set([
        PULL_COMMAND_INFLIGHT_ERROR,
        'device_managing_agent_binding_missing',
        'device_managing_agent_binding_conflict',
        'device_uid_superseded_without_canonical',
        EXECUTION_GATE_REASON_CODES.SITE_CONTEXT_MISSING_FOR_PULL,
        EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISMATCH,
        EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISSING,
        EXECUTION_GATE_REASON_CODES.DEVICE_BINDING_SITE_RUNTIME_CONFLICT,
        EXECUTION_GATE_REASON_CODES.RUNTIME_REPORTED_STATE_MISSING,
        EXECUTION_GATE_REASON_CODES.RUNTIME_REPORTED_STATE_STALE,
        EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_OFFLINE,
        EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_BLOCKED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_UNKNOWN,
        EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_UNSUPPORTED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_UNKNOWN,
        EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_OUTDATED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_UNSUPPORTED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_DISABLED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_UNKNOWN,
        EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_UNSUPPORTED,
        EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_DISABLED,
        EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_UNKNOWN
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

    const command = result.value;
    logBridgeEvent('bridge.api.admin.command.pull_device_events.queued', {
      company_id: companyId,
      agent_id: agentId,
      device_uid: validated.value.device_uid,
      command_id: command.id
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.command.pull_device_events',
      target: req.originalUrl || req.path,
      metadata: {
        agent_id: agentId,
        device_uid: validated.value.device_uid,
        command_id: command.id,
        request_capture: requestCapture
      }
    });

    return res.status(201).json(command);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/agents/:agentId/commands/refresh-device-path-pull-capability', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const deviceUid = typeof body.device_uid === 'string' ? body.device_uid.trim() : '';
    if (!deviceUid) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'device_uid is required'
        }
      });
    }

    const companyId = resolved.value;
    const agentId = req.params.agentId;
    const result = await queueDevicePathPullCapabilityRefreshCommand(db, {
      companyId,
      agentId,
      deviceUid,
      options: body.options && typeof body.options === 'object' ? body.options : {},
      createdByKeyId: req.ctx ? req.ctx.key_id_or_prefix : null
    });

    if (result.error) {
      const notFoundErrors = new Set(['agent_not_found', 'device_not_found']);
      const conflictErrors = new Set([
        'device_path_capability_refresh_already_in_flight',
        'device_managing_agent_binding_missing',
        'device_managing_agent_binding_conflict',
        'device_uid_superseded_without_canonical',
        EXECUTION_GATE_REASON_CODES.SITE_CONTEXT_MISSING_FOR_PULL,
        EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISMATCH,
        EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISSING,
        EXECUTION_GATE_REASON_CODES.DEVICE_BINDING_SITE_RUNTIME_CONFLICT,
        EXECUTION_GATE_REASON_CODES.RUNTIME_REPORTED_STATE_MISSING,
        EXECUTION_GATE_REASON_CODES.RUNTIME_REPORTED_STATE_STALE,
        EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_OFFLINE,
        EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_BLOCKED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_UNKNOWN,
        EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_UNSUPPORTED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_UNKNOWN,
        EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_OUTDATED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_UNSUPPORTED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_DISABLED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_UNKNOWN
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

    const command = result.value;
    logBridgeEvent('bridge.api.admin.command.refresh_device_path_pull_capability.queued', {
      company_id: companyId,
      agent_id: agentId,
      device_uid: deviceUid,
      command_id: command.id
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.command.refresh_device_path_pull_capability',
      target: req.originalUrl || req.path,
      metadata: {
        agent_id: agentId,
        device_uid: deviceUid,
        command_id: command.id
      }
    });

    return res.status(201).json(command);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/commands', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : '';
    const allowedStatuses = new Set(['queued', 'sent', 'acknowledged', 'failed', 'expired']);
    if (status && !allowedStatuses.has(status)) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'status must be one of queued, sent, acknowledged, failed, expired'
        }
      });
    }

    await reconcileAgentCommandLifecycle(db, {
      companyId,
      agentId: typeof req.query.agent_id === 'string' ? req.query.agent_id : null
    });

    const rows = await listAgentCommands(db, {
      companyId,
      agentId: req.query.agent_id,
      deviceUid: req.query.device_uid,
      status,
      createdFrom: req.query.created_from,
      createdTo: req.query.created_to,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    logBridgeEvent('bridge.api.admin.commands.listed', {
      company_id: companyId,
      count: rows.length
    });
    return res.json({
      value: rows,
      count: rows.length
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

router.get('/lifecycle-integrity', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const includeDetails = parseBooleanFlag(req.query.include_details, false);
    if (includeDetails.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: `include_details ${includeDetails.error}`
        }
      });
    }

    const companyId = resolved.value;
    const report = await getLifecycleIntegrityReport(db, {
      companyId,
      includeDetails: includeDetails.value,
      detailLimit: parseLimit(req.query.detail_limit)
    });

    logBridgeEvent('bridge.api.admin.lifecycle_integrity.viewed', {
      company_id: companyId,
      include_details: includeDetails.value,
      strict_issue_count_total: report.strict_issue_count_total,
      advisory_issue_count_total: report.advisory_issue_count_total
    });

    return res.json(report);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/lifecycle-reconciliation/dry-run', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const report = await getLifecycleReconciliationDryRun(db, {
      companyId,
      detailLimit: parseLimit(req.query.detail_limit)
    });

    logBridgeEvent('bridge.api.admin.lifecycle_reconciliation.dry_run.viewed', {
      company_id: companyId,
      strict_issue_count_total: report.strict_issue_count_total,
      findings_count: report.findings_count
    });

    return res.json(report);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/lifecycle-reconciliation/repair', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const anomalyType = typeof body.anomaly_type === 'string' ? body.anomaly_type.trim() : '';
    if (!anomalyType) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'anomaly_type is required'
        }
      });
    }

    const targetDeviceUid = typeof body.target_device_uid === 'string' ? body.target_device_uid.trim() : '';
    if (!targetDeviceUid) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'target_device_uid is required'
        }
      });
    }

    const applyFlag = parseBooleanFlag(body.apply, false);
    if (applyFlag.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: `apply ${applyFlag.error}`
        }
      });
    }

    const companyId = resolved.value;
    const metadata = (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata))
      ? body.metadata
      : {};

    const repairResult = await executeLifecycleReconciliationRepair(db, {
      companyId,
      anomalyType,
      targetDeviceUid,
      apply: applyFlag.value,
      actorType: req.ctx ? req.ctx.role : 'operator',
      actorRef: req.ctx ? req.ctx.key_id_or_prefix : null,
      reason: typeof body.reason === 'string' ? body.reason : null,
      metadata,
      correlationId: typeof body.correlation_id === 'string' ? body.correlation_id : null
    });

    if (repairResult.error) {
      const notFoundErrors = new Set(['device_not_found']);
      const conflictErrors = new Set([
        'device_uid_superseded_without_canonical',
        'device_uid_superseded_use_canonical',
        'lifecycle_repair_conflict_active_alias_owned_by_other_canonical',
        'lifecycle_repair_alias_conflict_vendor_key'
      ]);
      const status = notFoundErrors.has(repairResult.error)
        ? 404
        : (conflictErrors.has(repairResult.error) ? 409 : 400);
      const code = notFoundErrors.has(repairResult.error)
        ? 'LOOKUP_NOT_FOUND'
        : (conflictErrors.has(repairResult.error) ? 'CONFLICT' : 'VALIDATION_ERROR');
      const kind = notFoundErrors.has(repairResult.error)
        ? 'lookup_error'
        : (conflictErrors.has(repairResult.error) ? 'conflict' : 'validation');
      return sendError(res, {
        status,
        code,
        message: status === 404 ? 'Not found' : (status === 409 ? 'Conflict' : 'Validation failed'),
        details: {
          kind,
          error: repairResult.error,
          ...(repairResult.value ? repairResult.value : {})
        }
      });
    }

    const value = repairResult.value || {};
    logBridgeEvent('bridge.api.admin.lifecycle_reconciliation.repair.executed', {
      company_id: companyId,
      anomaly_type: value.anomaly_type || anomalyType,
      requested_device_uid: value.requested_device_uid || targetDeviceUid,
      canonical_device_uid: value.canonical_device_uid || null,
      mode: value.mode || (applyFlag.value ? 'apply' : 'dry_run'),
      write_executed: value.write_executed === true,
      repair_result: value.repair_result || null
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.lifecycle_reconciliation.repair',
      target: req.originalUrl || req.path,
      metadata: {
        anomaly_type: value.anomaly_type || anomalyType,
        requested_device_uid: value.requested_device_uid || targetDeviceUid,
        canonical_device_uid: value.canonical_device_uid || null,
        mode: value.mode || (applyFlag.value ? 'apply' : 'dry_run'),
        write_executed: value.write_executed === true,
        repair_result: value.repair_result || null
      }
    });

    return res.json(value);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/sites', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const rows = await listSites(db, {
      companyId,
      status: req.query.status,
      productSurface: parseBooleanFlag(req.query.product_surface).value === true,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    logBridgeEvent('bridge.api.admin.sites.listed', {
      company_id: companyId,
      count: rows.length
    });
    return res.json({
      value: rows,
      count: rows.length
    });
  } catch (err) {
    if (err && err.code === 'invalid_request') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: err.detail
        }
      });
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/sites', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const created = await createSite(db, {
      companyId,
      siteKey: body.site_key,
      siteName: body.site_name,
      status: body.status,
      metadata: body.metadata || {}
    });
    logBridgeEvent('bridge.api.admin.site.created', {
      company_id: companyId,
      site_id: created && created.site_id ? created.site_id : null,
      site_key: created && created.site_key ? created.site_key : null
    });
    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.site.create',
      target: req.originalUrl || req.path,
      metadata: {
        site_id: created && created.site_id ? created.site_id : null,
        site_key: created && created.site_key ? created.site_key : null,
        site_name: created && created.site_name ? created.site_name : null
      }
    });
    return res.status(201).json(created);
  } catch (err) {
    if (err && err.code === 'invalid_request') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: err.detail
        }
      });
    }
    if (err && err.code === 'conflict') {
      return sendError(res, {
        status: 409,
        code: 'CONFLICT',
        message: 'Conflict',
        details: {
          kind: 'conflict',
          error: 'site_key_conflict',
          detail: err.detail
        }
      });
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/sites/:siteId', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const site = await getSiteById(db, {
      companyId,
      siteId: req.params.siteId
    });
    if (!site) {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Site not found',
        details: {
          kind: 'lookup_error',
          error: 'site_not_found'
        }
      });
    }
    return res.json(site);
  } catch (err) {
    if (err && err.code === 'invalid_request') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: err.detail
        }
      });
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.patch('/sites/:siteId', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const updated = await updateSite(db, {
      companyId,
      siteId: req.params.siteId,
      siteName: Object.prototype.hasOwnProperty.call(body, 'site_name') ? body.site_name : undefined,
      status: Object.prototype.hasOwnProperty.call(body, 'status') ? body.status : undefined,
      metadata: Object.prototype.hasOwnProperty.call(body, 'metadata') ? body.metadata : undefined
    });
    if (!updated) {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Site not found',
        details: {
          kind: 'lookup_error',
          error: 'site_not_found'
        }
      });
    }
    logBridgeEvent('bridge.api.admin.site.updated', {
      company_id: companyId,
      site_id: updated.site_id,
      site_key: updated.site_key
    });
    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.site.update',
      target: req.originalUrl || req.path,
      metadata: {
        site_id: updated.site_id,
        site_key: updated.site_key,
        site_name: updated.site_name,
        status: updated.status
      }
    });
    return res.json(updated);
  } catch (err) {
    if (err && err.code === 'invalid_request') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: err.detail
        }
      });
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/sites/:siteId/active-agent', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const site = await getSiteById(db, {
      companyId,
      siteId: req.params.siteId
    });
    if (!site) {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Site not found',
        details: {
          kind: 'lookup_error',
          error: 'site_not_found'
        }
      });
    }
    const activeLease = await getSiteActiveAgentLease(db, {
      companyId,
      siteId: req.params.siteId
    });
    return res.json({
      company_id: companyId,
      site_id: site.site_id,
      site_key: site.site_key,
      site_name: site.site_name,
      site_status: site.status,
      active_lease: activeLease
    });
  } catch (err) {
    if (err && err.code === 'invalid_request') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: err.detail
        }
      });
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/sites/:siteId/active-agent/history', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const site = await getSiteById(db, {
      companyId,
      siteId: req.params.siteId
    });
    if (!site) {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Site not found',
        details: {
          kind: 'lookup_error',
          error: 'site_not_found'
        }
      });
    }
    const rows = await listSiteAgentLeaseHistory(db, {
      companyId,
      siteId: req.params.siteId,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    return res.json({
      company_id: companyId,
      site_id: site.site_id,
      site_key: site.site_key,
      site_name: site.site_name,
      site_status: site.status,
      value: rows,
      count: rows.length
    });
  } catch (err) {
    if (err && err.code === 'invalid_request') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: err.detail
        }
      });
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.put('/sites/:siteId/active-agent', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'agent_id')) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'agent_id is required (use null to release active lease)'
        }
      });
    }
    const companyId = resolved.value;
    const result = await setSiteActiveAgentLease(db, {
      companyId,
      siteId: req.params.siteId,
      agentId: body.agent_id,
      leasedByKeyId: req.ctx ? req.ctx.key_id_or_prefix : null,
      metadata: Object.prototype.hasOwnProperty.call(body, 'metadata') ? body.metadata : {}
    });

    if (result.error === 'site_not_found') {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Site not found',
        details: {
          kind: 'lookup_error',
          error: 'site_not_found'
        }
      });
    }
    if (result.error === 'agent_not_found') {
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

    const value = result.value || {};
    logBridgeEvent('bridge.api.admin.site.active_agent.updated', {
      company_id: companyId,
      site_id: value.site && value.site.site_id ? value.site.site_id : req.params.siteId,
      action: value.action || 'unknown',
      active_agent_id: value.active_lease && value.active_lease.agent_id ? value.active_lease.agent_id : null
    });
    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.site.active_agent.set',
      target: req.originalUrl || req.path,
      metadata: {
        site_id: value.site && value.site.site_id ? value.site.site_id : req.params.siteId,
        action_result: value.action || null,
        requested_agent_id: body.agent_id === null ? null : body.agent_id,
        active_agent_id: value.active_lease && value.active_lease.agent_id ? value.active_lease.agent_id : null,
        previous_active_agent_id: value.previous_active_lease && value.previous_active_lease.agent_id
          ? value.previous_active_lease.agent_id
          : null
      }
    });

    return res.json(value);
  } catch (err) {
    if (err && err.code === 'invalid_request') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: err.detail
        }
      });
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.put('/agents/:agentId/site', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    if (!Object.prototype.hasOwnProperty.call(body, 'site_id')) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'site_id is required (use null to clear assignment)'
        }
      });
    }
    const requestedSiteId = body.site_id;
    const normalizedSiteId = normalizeUuidOrNull(requestedSiteId);
    if (normalizedSiteId) {
      const site = await getSiteById(db, { companyId, siteId: normalizedSiteId });
      if (!site) {
        return sendError(res, {
          status: 404,
          code: 'LOOKUP_NOT_FOUND',
          message: 'Site not found',
          details: {
            kind: 'lookup_error',
            error: 'site_not_found'
          }
        });
      }
    }

    const updated = await setAgentSiteAssignment(db, {
      companyId,
      agentId: req.params.agentId,
      siteId: normalizedSiteId
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

    logBridgeEvent('bridge.api.admin.agent.site_assignment.updated', {
      company_id: companyId,
      agent_id: updated.id,
      site_id: updated.site_id || null
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.agent.site_assignment',
      target: req.originalUrl || req.path,
      metadata: {
        agent_id: updated.id,
        site_id: updated.site_id || null
      }
    });

    return res.json(updated);
  } catch (err) {
    if (err && err.code === 'invalid_request') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: err.detail
        }
      });
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.put('/devices/:deviceUid/site', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const requestedDeviceUid = typeof req.params.deviceUid === 'string' ? req.params.deviceUid.trim() : '';
    if (!requestedDeviceUid) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'device_uid is required'
        }
      });
    }

    const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
      companyId,
      deviceUid: requestedDeviceUid
    });
    if (canonicalResolution.resolved_by === 'superseded_without_canonical') {
      return sendError(res, {
        status: 409,
        code: 'CONFLICT',
        message: 'Conflict',
        details: {
          kind: 'conflict',
          error: 'device_uid_superseded_without_canonical',
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalResolution.canonical_device_uid,
          canonical_resolved_by: canonicalResolution.resolved_by,
          canonical_alias_kind: canonicalResolution.alias_kind || null,
          canonical_alias_status: canonicalResolution.alias_status || null
        }
      });
    }
    const canonicalDeviceUid = String(canonicalResolution.canonical_device_uid || canonicalResolution.requested_device_uid || requestedDeviceUid).trim();

    if (!Object.prototype.hasOwnProperty.call(body, 'site_id')) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'site_id is required (use null to clear assignment)'
        }
      });
    }
    const requestedSiteId = body.site_id;
    const normalizedSiteId = normalizeUuidOrNull(requestedSiteId);
    if (normalizedSiteId) {
      const site = await getSiteById(db, { companyId, siteId: normalizedSiteId });
      if (!site) {
        return sendError(res, {
          status: 404,
          code: 'LOOKUP_NOT_FOUND',
          message: 'Site not found',
          details: {
            kind: 'lookup_error',
            error: 'site_not_found'
          }
        });
      }
    }

    const updated = await setDeviceSiteAssignment(db, {
      companyId,
      deviceUid: canonicalDeviceUid,
      siteId: normalizedSiteId
    });
    if (!updated) {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Device not found',
        details: {
          kind: 'lookup_error',
          error: 'device_not_found'
        }
      });
    }

    logBridgeEvent('bridge.api.admin.device.site_assignment.updated', {
      company_id: companyId,
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      site_id: updated.site_id || null
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.device.site_assignment',
      target: req.originalUrl || req.path,
      metadata: {
        requested_device_uid: requestedDeviceUid,
        canonical_device_uid: canonicalDeviceUid,
        canonical_resolved_by: canonicalResolution.resolved_by || 'direct',
        canonical_alias_kind: canonicalResolution.alias_kind || null,
        canonical_alias_status: canonicalResolution.alias_status || null,
        site_id: updated.site_id || null
      }
    });

    return res.json({
      ...updated,
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      canonical_resolved_by: canonicalResolution.resolved_by || 'direct',
      canonical_alias_kind: canonicalResolution.alias_kind || null,
      canonical_alias_status: canonicalResolution.alias_status || null
    });
  } catch (err) {
    if (err && err.code === 'invalid_request') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: err.detail
        }
      });
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/agents', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : '';
    const allowedStatuses = new Set(['active', 'inactive', 'revoked']);
    if (status && !allowedStatuses.has(status)) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'status must be one of active, inactive, revoked'
        }
      });
    }
    const seenSince = parseIsoDateTime(req.query.seen_since);
    if (seenSince.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: `seen_since ${seenSince.error}`
        }
      });
    }

    const rows = await listAgents(db, {
      companyId,
      status,
      seenSince: seenSince.value,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    logBridgeEvent('bridge.api.admin.agents.listed', {
      company_id: companyId,
      count: rows.length
    });
    return res.json({
      value: rows,
      count: rows.length
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

router.get('/version-policy', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const policy = await getAgentVersionPolicy(db, { companyId });
    logBridgeEvent('bridge.api.admin.version_policy.read', {
      company_id: companyId,
      policy_source: policy && policy.effective_policy
        ? policy.effective_policy.policy_source
        : null
    });
    return res.json(policy);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.put('/version-policy', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const validated = validateAgentVersionPolicyPayload(body);
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

    const companyId = resolved.value;
    const result = await setCompanyVersionPolicy(db, {
      companyId,
      minimumSupportedVersion: validated.value.minimum_supported_version,
      targetVersion: validated.value.target_version,
      rolloutChannel: validated.value.rollout_channel,
      metadata: {
        ...validated.value.metadata,
        source: 'agent_admin.version_policy.update'
      },
      updatedByKeyId: req.ctx ? req.ctx.key_id_or_prefix : null
    });

    logBridgeEvent('bridge.api.admin.version_policy.updated', {
      company_id: companyId,
      minimum_supported_version: validated.value.minimum_supported_version,
      target_version: validated.value.target_version,
      rollout_channel: validated.value.rollout_channel
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.version_policy.update',
      target: req.originalUrl || req.path,
      metadata: {
        minimum_supported_version: validated.value.minimum_supported_version,
        target_version: validated.value.target_version,
        rollout_channel: validated.value.rollout_channel
      }
    });

    return res.json(result.value);
  } catch (err) {
    if (err && err.code === 'invalid_request') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: err.detail
        }
      });
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/agents/:agentId/runtime-identity', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const agentId = req.params.agentId;
    const historyLimit = Number.parseInt(req.query.history_limit, 10);
    const identity = await getAgentRuntimeIdentity(db, {
      companyId,
      agentId,
      historyLimit: Number.isInteger(historyLimit) ? historyLimit : 10
    });

    if (identity.error === 'agent_not_found') {
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
    if (identity.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: identity.error
        }
      });
    }

    logBridgeEvent('bridge.api.admin.agent.runtime_identity.read', {
      company_id: companyId,
      agent_id: agentId,
      active_runtime_identity_id: identity.value.active_runtime_identity_id || null,
      identity_status: identity.value.identity_status || null
    });
    return res.json(identity.value);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/agents/:agentId/runtime-identity/reissue', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const agentId = req.params.agentId;
    const metadata = (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata))
      ? body.metadata
      : {};
    const rotateResult = await reissueAgentRuntimeIdentity(db, {
      companyId,
      agentId,
      actorType: req.ctx ? req.ctx.role : 'admin',
      actorRef: req.ctx ? req.ctx.key_id_or_prefix : null,
      reason: typeof body.reason === 'string' ? body.reason : null,
      metadata
    });

    if (rotateResult.error) {
      const notFoundErrors = new Set(['agent_not_found']);
      const conflictErrors = new Set(['agent_revoked']);
      return sendError(res, {
        status: notFoundErrors.has(rotateResult.error) ? 404 : (conflictErrors.has(rotateResult.error) ? 409 : 400),
        code: notFoundErrors.has(rotateResult.error)
          ? 'LOOKUP_NOT_FOUND'
          : (conflictErrors.has(rotateResult.error) ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: notFoundErrors.has(rotateResult.error)
          ? 'Agent not found'
          : (conflictErrors.has(rotateResult.error) ? 'Conflict' : 'Validation failed'),
        details: {
          kind: notFoundErrors.has(rotateResult.error)
            ? 'lookup_error'
            : (conflictErrors.has(rotateResult.error) ? 'conflict' : 'validation'),
          error: rotateResult.error
        }
      });
    }

    const value = rotateResult.value || {};
    logBridgeEvent('bridge.api.admin.agent.runtime_identity.reissued', {
      company_id: companyId,
      agent_id: value.agent_id || agentId,
      active_runtime_identity_id: value.active_runtime_identity_id || null,
      previous_runtime_identity_id: value.previous_runtime_identity_id || null,
      credential_version: value.credential_version || null
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.agent.runtime_identity.reissue',
      target: req.originalUrl || req.path,
      metadata: {
        agent_id: value.agent_id || agentId,
        active_runtime_identity_id: value.active_runtime_identity_id || null,
        previous_runtime_identity_id: value.previous_runtime_identity_id || null,
        credential_version: value.credential_version || null
      }
    });

    return res.status(201).json(value);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/agents/:agentId/runtime-identity/revoke', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const agentId = req.params.agentId;
    const metadata = (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata))
      ? body.metadata
      : {};
    const revokeResult = await revokeAgentRuntimeIdentity(db, {
      companyId,
      agentId,
      actorType: req.ctx ? req.ctx.role : 'admin',
      actorRef: req.ctx ? req.ctx.key_id_or_prefix : null,
      reason: typeof body.reason === 'string' ? body.reason : null,
      metadata
    });

    if (revokeResult.error) {
      const notFoundErrors = new Set(['agent_not_found']);
      const conflictErrors = new Set(['runtime_identity_not_active']);
      return sendError(res, {
        status: notFoundErrors.has(revokeResult.error) ? 404 : (conflictErrors.has(revokeResult.error) ? 409 : 400),
        code: notFoundErrors.has(revokeResult.error)
          ? 'LOOKUP_NOT_FOUND'
          : (conflictErrors.has(revokeResult.error) ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: notFoundErrors.has(revokeResult.error)
          ? 'Agent not found'
          : (conflictErrors.has(revokeResult.error) ? 'Conflict' : 'Validation failed'),
        details: {
          kind: notFoundErrors.has(revokeResult.error)
            ? 'lookup_error'
            : (conflictErrors.has(revokeResult.error) ? 'conflict' : 'validation'),
          error: revokeResult.error
        }
      });
    }

    const value = revokeResult.value || {};
    logBridgeEvent('bridge.api.admin.agent.runtime_identity.revoked', {
      company_id: companyId,
      agent_id: value.agent_id || agentId,
      revoked_runtime_identity_id: value.revoked_runtime_identity_id || null
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.agent.runtime_identity.revoke',
      target: req.originalUrl || req.path,
      metadata: {
        agent_id: value.agent_id || agentId,
        revoked_runtime_identity_id: value.revoked_runtime_identity_id || null,
        reason: value.reason || null
      }
    });

    return res.json(value);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/device-event-batches', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : '';
    const allowedStatuses = new Set(['accepted', 'partial', 'rejected']);
    if (status && !allowedStatuses.has(status)) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'status must be one of accepted, partial, rejected'
        }
      });
    }

    const createdFrom = parseIsoDateTime(req.query.created_from);
    if (createdFrom.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: `created_from ${createdFrom.error}`
        }
      });
    }
    const createdTo = parseIsoDateTime(req.query.created_to);
    if (createdTo.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: `created_to ${createdTo.error}`
        }
      });
    }
    const pullCompletedFrom = parseIsoDateTime(req.query.pull_completed_from);
    if (pullCompletedFrom.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: `pull_completed_from ${pullCompletedFrom.error}`
        }
      });
    }
    const pullCompletedTo = parseIsoDateTime(req.query.pull_completed_to);
    if (pullCompletedTo.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: `pull_completed_to ${pullCompletedTo.error}`
        }
      });
    }

    const rows = await listDeviceEventBatches(db, {
      companyId,
      agentId: req.query.agent_id,
      deviceUid: req.query.device_uid,
      status,
      createdFrom: createdFrom.value,
      createdTo: createdTo.value,
      pullCompletedFrom: pullCompletedFrom.value,
      pullCompletedTo: pullCompletedTo.value,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    logBridgeEvent('bridge.api.admin.device_event_batches.listed', {
      company_id: companyId,
      count: rows.length
    });
    return res.json({
      value: rows,
      count: rows.length
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

router.get('/device-events/recent', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const recent = await listRecentDeviceEvents(db, {
      companyId,
      deviceUid: req.query.device_uid,
      limit: parseLimit(req.query.limit)
    });
    logBridgeEvent('bridge.api.admin.device_events.recent.listed', {
      company_id: companyId,
      requested_device_uid: recent.requested_device_uid || null,
      canonical_device_uid: recent.canonical_device_uid || null,
      count: Array.isArray(recent.rows) ? recent.rows.length : 0
    });
    return res.json({
      requested_device_uid: recent.requested_device_uid,
      canonical_device_uid: recent.canonical_device_uid,
      canonical_resolved_by: recent.canonical_resolved_by,
      canonical_alias_kind: recent.canonical_alias_kind,
      canonical_alias_status: recent.canonical_alias_status,
      value: recent.rows,
      count: Array.isArray(recent.rows) ? recent.rows.length : 0
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

router.post('/devices/:deviceUid/monitoring-sessions', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const rtFlag = parseBooleanFlag(body.rt_enabled, true);
    if (rtFlag.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: `rt_enabled ${rtFlag.error}`
        }
      });
    }

    const result = await startMonitoringSession(db, {
      companyId: resolved.value,
      deviceUid: req.params.deviceUid,
      rtEnabled: rtFlag.value,
      ttlSeconds: parseMonitoringTtlSeconds(body.lease_ttl_seconds),
      expiresAt: body.expires_at,
      startedByKeyId: req.ctx ? req.ctx.key_id_or_prefix : null,
      startedByRole: req.ctx ? req.ctx.role : null,
      metadata: body.metadata
    });
    if (result.error) {
      return sendMonitoringServiceError(res, result);
    }
    const status = result.value && result.value.reused === true ? 200 : 201;
    return res.status(status).json(result.value);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/devices/:deviceUid/monitoring-sessions/current', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const result = await getCurrentSessionForDevice(db, {
      companyId: resolved.value,
      deviceUid: req.params.deviceUid
    });
    if (result.error) {
      return sendMonitoringServiceError(res, result);
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

router.get('/device-monitoring-sessions/:sessionId', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const result = await getSessionById(db, {
      companyId: resolved.value,
      sessionId: req.params.sessionId
    });
    if (result.error) {
      return sendMonitoringServiceError(res, result);
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

router.delete('/device-monitoring-sessions/:sessionId', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, req.body || {});
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const result = await stopMonitoringSession(db, {
      companyId: resolved.value,
      sessionId: req.params.sessionId,
      stopReason: req.body && req.body.stop_reason
    });
    if (result.error) {
      return sendMonitoringServiceError(res, result);
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

router.get('/devices/:deviceUid/realtime-observations', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const result = await listRealtimeObservations(db, {
      companyId: resolved.value,
      deviceUid: req.params.deviceUid,
      agentId: req.query.agent_id,
      afterCreatedAt: req.query.after_created_at,
      afterId: req.query.after_id,
      observedFrom: req.query.observed_from,
      observedTo: req.query.observed_to,
      limit: parseLimit(req.query.limit),
      ascending: false
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
    return res.json(result);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/devices/:deviceUid/realtime-observations/stream', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  const resolved = resolveCompanyId(req, null);
  if (resolved.error) {
    return sendError(res, {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: {
        kind: 'validation',
        error: 'invalid_request',
        detail: resolved.error
      }
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  let closed = false;
  let cursorCreatedAt = typeof req.query.after_created_at === 'string' ? req.query.after_created_at : null;
  let cursorId = typeof req.query.after_id === 'string' ? req.query.after_id : null;

  function writeEvent(eventName, data) {
    if (closed || res.destroyed) {
      return;
    }
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  writeEvent('ready', {
    status: 'ready',
    device_uid: req.params.deviceUid,
    polling_interval_ms: 1500,
    monitoring_control_plane_only: true
  });

  const poll = async () => {
    if (closed) {
      return;
    }
    try {
      const result = await listRealtimeObservations(db, {
        companyId: resolved.value,
        deviceUid: req.params.deviceUid,
        agentId: req.query.agent_id,
        afterCreatedAt: cursorCreatedAt,
        afterId: cursorId,
        limit: 100,
        ascending: true
      });
      if (result.error) {
        writeEvent('error', { error: result.error });
        return;
      }
      for (const row of result.value || []) {
        writeEvent('rt_observation', row);
        cursorCreatedAt = row.created_at;
        cursorId = row.id;
      }
    } catch (err) {
      writeEvent('error', {
        error: 'stream_poll_failed',
        message: err && err.message ? err.message : String(err)
      });
    }
  };

  const pollInterval = setInterval(poll, 1500);
  const keepaliveInterval = setInterval(() => {
    if (!closed && !res.destroyed) {
      res.write(': keepalive\n\n');
    }
  }, 15000);

  req.on('close', () => {
    closed = true;
    clearInterval(pollInterval);
    clearInterval(keepaliveInterval);
  });
});

router.get('/discovered-devices', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const rows = await listCandidateDevices(db, {
      companyId,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    const value = rows.map(attachManageabilityView);
    logBridgeEvent('bridge.api.admin.discovered_devices.listed', {
      company_id: companyId,
      count: value.length
    });
    return res.json({
      value,
      count: value.length
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

router.get('/devices/:deviceUid/onboarding-readiness', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const targetDeviceUid = typeof req.params.deviceUid === 'string' ? req.params.deviceUid.trim() : '';
    if (!targetDeviceUid) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'device_uid is required'
        }
      });
    }

    const rawWindow = Number.parseInt(req.query.online_window_minutes, 10);
    const onlineWindowMinutes = Number.isInteger(rawWindow) && rawWindow > 0
      ? Math.min(rawWindow, 240)
      : 10;

    const readiness = await getDeviceOnboardingReadiness(db, {
      companyId,
      deviceUid: targetDeviceUid,
      onlineWindowMinutes
    });

    if (readiness.error) {
      const isNotFound = readiness.error === 'device_not_found';
      const isConflict = readiness.error === 'device_uid_superseded_without_canonical';
      return sendError(res, {
        status: isNotFound ? 404 : (isConflict ? 409 : 400),
        code: isNotFound
          ? 'LOOKUP_NOT_FOUND'
          : (isConflict ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: isNotFound
          ? 'Not found'
          : (isConflict ? 'Conflict' : 'Validation failed'),
        details: {
          kind: isNotFound
            ? 'lookup_error'
            : (isConflict ? 'conflict' : 'validation'),
          error: readiness.error,
          ...(readiness.value ? readiness.value : {})
        }
      });
    }

    const value = readiness.value || {};
    logBridgeEvent('bridge.api.admin.device.onboarding_readiness.read', {
      company_id: companyId,
      requested_device_uid: value.requested_device_uid || targetDeviceUid,
      canonical_device_uid: value.canonical_device_uid || null,
      readiness_status: value.readiness_status || null,
      onboarding_state: value.onboarding_state || null,
      managed_status: value.managed_status || null
    });

    return res.json(value);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/devices/:deviceUid/user-inventory-snapshots/latest', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const requestedDeviceUid = typeof req.params.deviceUid === 'string' ? req.params.deviceUid.trim() : '';
    if (!requestedDeviceUid) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'device_uid is required'
        }
      });
    }

    const scope = parseInventoryScope(req.query.inventory_scope);
    if (scope.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: scope.error
        }
      });
    }

    const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
      companyId,
      deviceUid: requestedDeviceUid
    });

    if (canonicalResolution.error) {
      const isNotFound = canonicalResolution.error === 'device_not_found';
      const isConflict = canonicalResolution.error === 'device_uid_superseded_without_canonical';
      return sendError(res, {
        status: isNotFound ? 404 : (isConflict ? 409 : 400),
        code: isNotFound
          ? 'LOOKUP_NOT_FOUND'
          : (isConflict ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: isNotFound
          ? 'Not found'
          : (isConflict ? 'Conflict' : 'Validation failed'),
        details: {
          kind: isNotFound
            ? 'lookup_error'
            : (isConflict ? 'conflict' : 'validation'),
          error: canonicalResolution.error,
          requested_device_uid: canonicalResolution.requested_device_uid || requestedDeviceUid,
          canonical_device_uid: canonicalResolution.canonical_device_uid || requestedDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by || null,
          canonical_alias_kind: canonicalResolution.alias_kind || null,
          canonical_alias_status: canonicalResolution.alias_status || null
        }
      });
    }

    const canonicalDeviceUid = canonicalResolution.canonical_device_uid || requestedDeviceUid;
    const value = await getLatestDeviceUserInventorySnapshot(db, {
      companyId,
      deviceUid: canonicalDeviceUid,
      inventoryScope: scope.value
    });
    const candidate_evaluation = computeConservativeNextCandidateFromSnapshot(value);

    logBridgeEvent('bridge.api.admin.device.user_inventory_snapshot.latest.read', {
      company_id: companyId,
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      inventory_scope: scope.value,
      found: Boolean(value),
      candidate_readiness_status: candidate_evaluation.candidate_readiness_status,
      candidate_strategy_id: candidate_evaluation.strategy_id,
      candidate_blocked_reason_code: candidate_evaluation.blocked_reason_code
    });

    return res.json({
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      inventory_scope: scope.value,
      value,
      candidate_evaluation
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

router.post('/devices/:deviceUid/user-inventory-snapshots', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const requestedDeviceUid = typeof req.params.deviceUid === 'string' ? req.params.deviceUid.trim() : '';
    if (!requestedDeviceUid) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'device_uid is required'
        }
      });
    }

    const validated = validateInventorySnapshotCreatePayload(body);
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

    const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
      companyId,
      deviceUid: requestedDeviceUid
    });

    if (canonicalResolution.error) {
      const isNotFound = canonicalResolution.error === 'device_not_found';
      const isConflict = canonicalResolution.error === 'device_uid_superseded_without_canonical';
      return sendError(res, {
        status: isNotFound ? 404 : (isConflict ? 409 : 400),
        code: isNotFound
          ? 'LOOKUP_NOT_FOUND'
          : (isConflict ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: isNotFound
          ? 'Not found'
          : (isConflict ? 'Conflict' : 'Validation failed'),
        details: {
          kind: isNotFound
            ? 'lookup_error'
            : (isConflict ? 'conflict' : 'validation'),
          error: canonicalResolution.error,
          requested_device_uid: canonicalResolution.requested_device_uid || requestedDeviceUid,
          canonical_device_uid: canonicalResolution.canonical_device_uid || requestedDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by || null,
          canonical_alias_kind: canonicalResolution.alias_kind || null,
          canonical_alias_status: canonicalResolution.alias_status || null
        }
      });
    }

    const canonicalDeviceUid = canonicalResolution.canonical_device_uid || requestedDeviceUid;
    const value = await createDeviceUserInventorySnapshot(db, {
      companyId,
      deviceUid: canonicalDeviceUid,
      inventoryScope: validated.value.inventory_scope,
      snapshotTakenAt: validated.value.snapshot_taken_at,
      rawEvidenceRef: validated.value.raw_evidence_ref,
      parsedDeviceUserIds: validated.value.parsed_device_user_ids,
      inventoryConfidenceStatus: validated.value.inventory_confidence_status,
      inventoryCompletenessStatus: validated.value.inventory_completeness_status,
      nextCandidateDeviceUserId: validated.value.next_candidate_device_user_id,
      allocationStrategy: validated.value.allocation_strategy,
      strategyVersion: validated.value.strategy_version,
      notes: validated.value.notes,
      sourceMetadata: validated.value.source_metadata,
      createdBy: validated.value.created_by || (req.ctx && req.ctx.sub) || null
    });
    const candidate_evaluation = computeConservativeNextCandidateFromSnapshot(value);

    logBridgeEvent('bridge.api.admin.device.user_inventory_snapshot.created', {
      company_id: companyId,
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      inventory_snapshot_id: value.id,
      inventory_scope: value.inventory_scope,
      parsed_user_count: value.parsed_user_count,
      inventory_confidence_status: value.inventory_confidence_status,
      inventory_completeness_status: value.inventory_completeness_status,
      candidate_readiness_status: candidate_evaluation.candidate_readiness_status,
      candidate_strategy_id: candidate_evaluation.strategy_id,
      candidate_blocked_reason_code: candidate_evaluation.blocked_reason_code
    });

    return res.status(201).json({
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      value,
      candidate_evaluation
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

router.get('/devices/:deviceUid/user-inventory-snapshots/latest/candidate', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const requestedDeviceUid = typeof req.params.deviceUid === 'string' ? req.params.deviceUid.trim() : '';
    if (!requestedDeviceUid) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'device_uid is required'
        }
      });
    }

    const scope = parseInventoryScope(req.query.inventory_scope);
    if (scope.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: scope.error
        }
      });
    }

    const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
      companyId,
      deviceUid: requestedDeviceUid
    });
    if (canonicalResolution.error) {
      const isNotFound = canonicalResolution.error === 'device_not_found';
      const isConflict = canonicalResolution.error === 'device_uid_superseded_without_canonical';
      return sendError(res, {
        status: isNotFound ? 404 : (isConflict ? 409 : 400),
        code: isNotFound
          ? 'LOOKUP_NOT_FOUND'
          : (isConflict ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: isNotFound
          ? 'Not found'
          : (isConflict ? 'Conflict' : 'Validation failed'),
        details: {
          kind: isNotFound
            ? 'lookup_error'
            : (isConflict ? 'conflict' : 'validation'),
          error: canonicalResolution.error,
          requested_device_uid: canonicalResolution.requested_device_uid || requestedDeviceUid,
          canonical_device_uid: canonicalResolution.canonical_device_uid || requestedDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by || null,
          canonical_alias_kind: canonicalResolution.alias_kind || null,
          canonical_alias_status: canonicalResolution.alias_status || null
        }
      });
    }

    const canonicalDeviceUid = canonicalResolution.canonical_device_uid || requestedDeviceUid;
    const value = await getLatestDeviceUserInventorySnapshot(db, {
      companyId,
      deviceUid: canonicalDeviceUid,
      inventoryScope: scope.value
    });
    const candidate_evaluation = computeConservativeNextCandidateFromSnapshot(value);

    logBridgeEvent('bridge.api.admin.device.user_inventory_snapshot.candidate.read', {
      company_id: companyId,
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      inventory_scope: scope.value,
      strategy_id: INVENTORY_CANDIDATE_STRATEGY.ID,
      candidate_readiness_status: candidate_evaluation.candidate_readiness_status,
      candidate_blocked_reason_code: candidate_evaluation.blocked_reason_code,
      candidate_is_ready: candidate_evaluation.candidate_readiness_status === INVENTORY_CANDIDATE_STATUS.READY
    });

    return res.json({
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      inventory_scope: scope.value,
      source_inventory_snapshot_id: value ? value.id : null,
      candidate_evaluation
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

router.post('/devices/:deviceUid/enrollment-preflight', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const preflightPayload = validateEnrollmentPreflightPayload(body);
    if (!preflightPayload.ok) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: preflightPayload.error
        }
      });
    }

    const companyId = resolved.value;
    const requestedDeviceUid = typeof req.params.deviceUid === 'string' ? req.params.deviceUid.trim() : '';
    if (!requestedDeviceUid) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'device_uid is required'
        }
      });
    }

    const scope = parseInventoryScope(body.inventory_scope);
    if (scope.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: scope.error
        }
      });
    }

    const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
      companyId,
      deviceUid: requestedDeviceUid
    });
    if (canonicalResolution.error) {
      const isNotFound = canonicalResolution.error === 'device_not_found';
      const isConflict = canonicalResolution.error === 'device_uid_superseded_without_canonical';
      return sendError(res, {
        status: isNotFound ? 404 : (isConflict ? 409 : 400),
        code: isNotFound
          ? 'LOOKUP_NOT_FOUND'
          : (isConflict ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: isNotFound
          ? 'Not found'
          : (isConflict ? 'Conflict' : 'Validation failed'),
        details: {
          kind: isNotFound
            ? 'lookup_error'
            : (isConflict ? 'conflict' : 'validation'),
          error: canonicalResolution.error,
          requested_device_uid: canonicalResolution.requested_device_uid || requestedDeviceUid,
          canonical_device_uid: canonicalResolution.canonical_device_uid || requestedDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by || null,
          canonical_alias_kind: canonicalResolution.alias_kind || null,
          canonical_alias_status: canonicalResolution.alias_status || null
        }
      });
    }

    const canonicalDeviceUid = canonicalResolution.canonical_device_uid || requestedDeviceUid;
    const snapshot = await getLatestDeviceUserInventorySnapshot(db, {
      companyId,
      deviceUid: canonicalDeviceUid,
      inventoryScope: scope.value
    });
    const candidateEvaluation = computeConservativeNextCandidateFromSnapshot(snapshot);
    const preflight = evaluateEnrollmentPreflight({
      snapshot,
      candidateEvaluation,
      manualOverride: preflightPayload.value.manual_override
    });

    const auditRef = crypto.randomUUID();
    preflight.manual_override_actor = preflight.manual_override_used
      ? ((req.ctx && req.ctx.sub) || (req.ctx && req.ctx.key_id_or_prefix) || null)
      : null;
    preflight.audit_ref = auditRef;

    const persistedDecision = await createEnrollmentPreflightDecision(db, {
      companyId,
      deviceUid: canonicalDeviceUid,
      inventoryScope: scope.value,
      sourceInventorySnapshotId: preflight.source_inventory_snapshot_id,
      sourceCandidateEvaluation: preflight.source_candidate_evaluation,
      selectedCandidateDeviceUserId: preflight.selected_candidate_device_user_id,
      selectedSource: preflight.selected_source,
      preflightReadinessStatus: preflight.preflight_readiness_status,
      blockedReasonCode: preflight.blocked_reason_code,
      manualOverrideUsed: preflight.manual_override_used,
      manualOverrideActor: preflight.manual_override_actor,
      manualOverrideReason: preflight.manual_override_reason,
      manualOverrideNote: preflight.manual_override_note,
      manualOverrideRequired: preflight.manual_override_required,
      auditRef,
      evaluatedAt: preflight.evaluated_at,
      metadata: {
        note: preflightPayload.value.note,
        selected_source: preflight.selected_source,
        selected_source_kind: preflight.selected_source === ENROLLMENT_PREFLIGHT_SELECTED_SOURCE.AUTO_CANDIDATE
          ? 'auto'
          : (preflight.selected_source === ENROLLMENT_PREFLIGHT_SELECTED_SOURCE.MANUAL_OVERRIDE ? 'manual' : 'none')
      }
    });

    logBridgeEvent('bridge.api.admin.device.enrollment_preflight.evaluated', {
      company_id: companyId,
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      inventory_scope: scope.value,
      preflight_readiness_status: preflight.preflight_readiness_status,
      blocked_reason_code: preflight.blocked_reason_code,
      selected_source: preflight.selected_source,
      selected_candidate_device_user_id: preflight.selected_candidate_device_user_id,
      manual_override_used: preflight.manual_override_used,
      audit_ref: auditRef
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.device.enrollment_preflight.evaluate',
      target: req.originalUrl || req.path,
      metadata: {
        requested_device_uid: requestedDeviceUid,
        canonical_device_uid: canonicalDeviceUid,
        preflight_readiness_status: preflight.preflight_readiness_status,
        blocked_reason_code: preflight.blocked_reason_code,
        selected_source: preflight.selected_source,
        selected_candidate_device_user_id: preflight.selected_candidate_device_user_id,
        manual_override_used: preflight.manual_override_used,
        manual_override_reason: preflight.manual_override_reason,
        manual_override_note: preflight.manual_override_note,
        source_inventory_snapshot_id: preflight.source_inventory_snapshot_id,
        audit_ref: auditRef,
        preflight_decision_id: persistedDecision ? persistedDecision.id : null
      }
    });

    return res.status(200).json({
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      inventory_scope: scope.value,
      source_inventory_snapshot_id: preflight.source_inventory_snapshot_id,
      source_candidate_evaluation: preflight.source_candidate_evaluation,
      preflight: {
        preflight_readiness_status: preflight.preflight_readiness_status,
        blocked_reason_code: preflight.blocked_reason_code,
        selected_candidate_device_user_id: preflight.selected_candidate_device_user_id,
        selected_source: preflight.selected_source,
        manual_override_used: preflight.manual_override_used,
        manual_override_actor: preflight.manual_override_actor,
        manual_override_reason: preflight.manual_override_reason,
        manual_override_note: preflight.manual_override_note,
        manual_override_required: preflight.manual_override_required,
        audit_ref: preflight.audit_ref,
        evaluated_at: preflight.evaluated_at
      },
      decision_record: persistedDecision
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

router.post('/devices/:deviceUid/enrollment-attempts', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const requestedDeviceUid = typeof req.params.deviceUid === 'string' ? req.params.deviceUid.trim() : '';
    if (!requestedDeviceUid) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'device_uid is required'
        }
      });
    }

    const validated = validateEnrollmentAttemptStartPayload(body);
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

    const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
      companyId,
      deviceUid: requestedDeviceUid
    });
    if (canonicalResolution.error) {
      const isNotFound = canonicalResolution.error === 'device_not_found';
      const isConflict = canonicalResolution.error === 'device_uid_superseded_without_canonical';
      return sendError(res, {
        status: isNotFound ? 404 : (isConflict ? 409 : 400),
        code: isNotFound
          ? 'LOOKUP_NOT_FOUND'
          : (isConflict ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: isNotFound
          ? 'Not found'
          : (isConflict ? 'Conflict' : 'Validation failed'),
        details: {
          kind: isNotFound
            ? 'lookup_error'
            : (isConflict ? 'conflict' : 'validation'),
          error: canonicalResolution.error,
          requested_device_uid: canonicalResolution.requested_device_uid || requestedDeviceUid,
          canonical_device_uid: canonicalResolution.canonical_device_uid || requestedDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by || null,
          canonical_alias_kind: canonicalResolution.alias_kind || null,
          canonical_alias_status: canonicalResolution.alias_status || null
        }
      });
    }

    const canonicalDeviceUid = canonicalResolution.canonical_device_uid || requestedDeviceUid;
    const latestDecision = await getLatestEnrollmentPreflightDecision(db, {
      companyId,
      deviceUid: canonicalDeviceUid,
      inventoryScope: validated.value.inventory_scope
    });
    const selectedDecision = await getEnrollmentPreflightDecisionById(db, {
      companyId,
      preflightDecisionId: validated.value.preflight_decision_id
    });
    const preflightCheck = validatePreflightForEnrollmentStart({
      canonicalDeviceUid,
      inventoryScope: validated.value.inventory_scope,
      latestDecision,
      selectedDecision
    });
    if (preflightCheck.error) {
      return sendError(res, {
        status: 409,
        code: 'CONFLICT',
        message: 'Conflict',
        details: {
          kind: 'conflict',
          error: preflightCheck.error
        }
      });
    }

    const attempt = await createEnrollmentAttempt(db, {
      companyId,
      deviceUid: canonicalDeviceUid,
      inventoryScope: validated.value.inventory_scope,
      personId: validated.value.person_id,
      deviceUserId: preflightCheck.value.selected_device_user_id,
      selectedFinger: validated.value.selected_finger,
      preflightDecisionId: validated.value.preflight_decision_id,
      createdBy: (req.ctx && req.ctx.sub) || (req.ctx && req.ctx.key_id_or_prefix) || null,
      sourceMetadata: {
        selected_source: preflightCheck.value.selected_source || null,
        source_note: validated.value.source_note || null,
        protocol_execution_state: 'not_started',
        execution_profile: 'k80_enrollment_v1_placeholder'
      }
    });

    logBridgeEvent('bridge.api.admin.device.enrollment_attempt.started', {
      company_id: companyId,
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      enrollment_attempt_id: attempt.id,
      preflight_decision_id: attempt.preflight_decision_id,
      selected_source: preflightCheck.value.selected_source || null,
      device_user_id: attempt.device_user_id,
      attempt_status: attempt.attempt_status
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.device.enrollment_attempt.start',
      target: req.originalUrl || req.path,
      metadata: {
        requested_device_uid: requestedDeviceUid,
        canonical_device_uid: canonicalDeviceUid,
        enrollment_attempt_id: attempt.id,
        person_id: attempt.person_id,
        device_user_id: attempt.device_user_id,
        selected_finger: attempt.selected_finger,
        preflight_decision_id: attempt.preflight_decision_id,
        selected_source: preflightCheck.value.selected_source || null,
        attempt_status: attempt.attempt_status
      }
    });

    return res.status(202).json({
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      value: attempt
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

router.post('/enrollment-attempts/:attemptId/execute', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const attemptId = typeof req.params.attemptId === 'string' ? req.params.attemptId.trim() : '';
    if (!attemptId) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'attempt_id is required'
        }
      });
    }

    const queued = await queueK80EnrollmentAttemptExecutionCommand(db, {
      companyId,
      enrollmentAttemptId: attemptId,
      requestedDeviceUid: typeof body.device_uid === 'string' ? body.device_uid : null,
      createdByKeyId: req.ctx ? req.ctx.key_id_or_prefix : null,
      createdByRole: req.ctx ? req.ctx.role : null
    });
    if (queued.error) {
      const notFoundErrors = new Set(['enrollment_attempt_not_found', 'device_not_found', 'agent_not_found']);
      const conflictErrors = new Set([
        'enrollment_attempt_scope_not_supported',
        'enrollment_attempt_not_pending',
        'enrollment_attempt_device_mismatch',
        'enrollment_command_already_in_flight',
        'device_managing_agent_binding_missing',
        'agent_not_active',
        'device_uid_superseded_without_canonical',
        EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISMATCH,
        EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISSING,
        EXECUTION_GATE_REASON_CODES.RUNTIME_REPORTED_STATE_MISSING,
        EXECUTION_GATE_REASON_CODES.RUNTIME_REPORTED_STATE_STALE,
        EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_OFFLINE,
        EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_BLOCKED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_UNKNOWN,
        EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_UNSUPPORTED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_UNKNOWN,
        EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_OUTDATED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_UNSUPPORTED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_DISABLED,
        EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_UNKNOWN,
        EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_UNSUPPORTED,
        EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_DISABLED,
        EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_UNKNOWN
      ]);
      return sendError(res, {
        status: notFoundErrors.has(queued.error) ? 404 : (conflictErrors.has(queued.error) ? 409 : 400),
        code: notFoundErrors.has(queued.error)
          ? 'LOOKUP_NOT_FOUND'
          : (conflictErrors.has(queued.error) ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: notFoundErrors.has(queued.error)
          ? 'Not found'
          : (conflictErrors.has(queued.error) ? 'Conflict' : 'Validation failed'),
        details: {
          kind: notFoundErrors.has(queued.error)
            ? 'lookup_error'
            : (conflictErrors.has(queued.error) ? 'conflict' : 'validation'),
          error: queued.error,
          ...(queued.value ? queued.value : {})
        }
      });
    }

    logBridgeEvent('bridge.api.admin.device.enrollment_attempt.execution_queued', {
      company_id: companyId,
      enrollment_attempt_id: queued.value.enrollment_attempt_id,
      canonical_device_uid: queued.value.canonical_device_uid,
      command_id: queued.value.command ? queued.value.command.id : null,
      agent_id: queued.value.agent_id || null
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.device.enrollment_attempt.execute',
      target: req.originalUrl || req.path,
      metadata: {
        enrollment_attempt_id: queued.value.enrollment_attempt_id,
        canonical_device_uid: queued.value.canonical_device_uid,
        command_id: queued.value.command ? queued.value.command.id : null,
        agent_id: queued.value.agent_id || null
      }
    });

    return res.status(202).json({
      value: queued.value
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

router.get('/enrollment-attempts/:attemptId', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const attemptId = typeof req.params.attemptId === 'string' ? req.params.attemptId.trim() : '';
    if (!attemptId) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'attempt_id is required'
        }
      });
    }

    const value = await getEnrollmentAttemptById(db, {
      companyId,
      enrollmentAttemptId: attemptId
    });
    if (!value) {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Enrollment attempt not found',
        details: {
          kind: 'lookup_error',
          error: 'enrollment_attempt_not_found'
        }
      });
    }

    return res.json({ value });
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/devices/manual-onboarding', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const validated = validateManualDeviceOnboardingPayload(body);
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

    const result = await upsertManualOnboardingCandidate(db, {
      companyId,
      payload: validated.value,
      actorType: req.ctx ? req.ctx.role : 'operator',
      actorRef: req.ctx ? req.ctx.key_id_or_prefix : null,
      correlationId: typeof body.correlation_id === 'string' ? body.correlation_id : null
    });
    if (result.error) {
      const conflictErrors = new Set([
        'device_not_candidate',
        'device_uid_superseded_without_canonical'
      ]);
      return sendError(res, {
        status: conflictErrors.has(result.error) ? 409 : 400,
        code: conflictErrors.has(result.error) ? 'CONFLICT' : 'VALIDATION_ERROR',
        message: conflictErrors.has(result.error) ? 'Conflict' : 'Validation failed',
        details: {
          kind: conflictErrors.has(result.error) ? 'conflict' : 'validation',
          error: result.error,
          ...(result.value ? result.value : {})
        }
      });
    }

    const value = result.value;
    logBridgeEvent('bridge.api.admin.device.manual_onboarding.upserted', {
      company_id: companyId,
      requested_device_uid: validated.value.device_uid || validated.value.canonical_device_uid || null,
      canonical_device_uid: value.device_uid,
      managed_status: value.managed_status,
      lifecycle_scope: value.lifecycle_scope,
      configuration_status: value.configuration_status,
      ready_for_validation: value.ready_for_validation,
      created: value.created === true
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.device.manual_onboarding.upsert',
      target: req.originalUrl || req.path,
      metadata: {
        requested_device_uid: validated.value.device_uid || validated.value.canonical_device_uid || null,
        canonical_device_uid: value.device_uid,
        managed_status: value.managed_status,
        lifecycle_scope: value.lifecycle_scope,
        configuration_status: value.configuration_status,
        ready_for_validation: value.ready_for_validation,
        created: value.created === true
      }
    });

    return res.status(value.created ? 201 : 200).json({
      company_id: value.company_id,
      device_uid: value.device_uid,
      provider: value.provider,
      managed_status: value.managed_status,
      lifecycle_scope: value.lifecycle_scope,
      configuration_status: value.configuration_status,
      missing_required_fields: value.missing_required_fields,
      ready_for_validation: value.ready_for_validation,
      validation_status: value.validation_status || 'never_run',
      validation_reason_code: value.validation_reason_code || null,
      validation_last_requested_at: value.validation_last_requested_at || null,
      validation_last_started_at: value.validation_last_started_at || null,
      validation_last_completed_at: value.validation_last_completed_at || null,
      validation_last_success_at: value.validation_last_success_at || null,
      validation_last_failure_at: value.validation_last_failure_at || null,
      onboarding_state: value.onboarding_state || null
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

router.post('/devices/:deviceUid/validate', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const validated = validateManualDeviceValidationRequestPayload(body);
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

    const companyId = resolved.value;
    const result = await queueValidateDeviceCandidateCommand(db, {
      companyId,
      agentId: validated.value.agent_id,
      deviceUid: req.params.deviceUid,
      options: validated.value.options,
      createdByKeyId: req.ctx ? req.ctx.key_id_or_prefix : null,
      createdByRole: req.ctx ? req.ctx.role : null,
      correlationId: validated.value.correlation_id
    });

    if (result.error) {
      const notFoundErrors = new Set(['agent_not_found', 'device_not_found']);
        const conflictErrors = new Set([
          'device_not_candidate',
          'device_not_bridge_scope',
          'validation_command_already_in_flight',
          'device_uid_superseded_without_canonical',
          EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISMATCH,
          EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISSING,
          EXECUTION_GATE_REASON_CODES.RUNTIME_REPORTED_STATE_MISSING,
          EXECUTION_GATE_REASON_CODES.RUNTIME_REPORTED_STATE_STALE,
          EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_OFFLINE,
          EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_BLOCKED,
          EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_UNKNOWN,
          EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_UNSUPPORTED,
          EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_UNKNOWN,
          EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_OUTDATED,
          EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_UNSUPPORTED,
          EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_DISABLED,
          EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_UNKNOWN,
          EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_UNSUPPORTED,
          EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_DISABLED,
          EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_UNKNOWN
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
    const command = value.command || {};

    logBridgeEvent('bridge.api.admin.device.validation.queued', {
      company_id: companyId,
      requested_device_uid: value.requested_device_uid || req.params.deviceUid,
      canonical_device_uid: value.canonical_device_uid || null,
      canonical_resolved_by: value.canonical_resolved_by || null,
      canonical_alias_kind: value.canonical_alias_kind || null,
      canonical_alias_status: value.canonical_alias_status || null,
      managed_status: value.managed_status || null,
      lifecycle_scope: value.lifecycle_scope || null,
      validation_status: value.validation_status || null,
      onboarding_state: value.onboarding_state || null,
      command_id: command.id || null,
      agent_id: command.agent_id || validated.value.agent_id
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.device.validate',
      target: req.originalUrl || req.path,
      metadata: {
        requested_device_uid: value.requested_device_uid || req.params.deviceUid,
        canonical_device_uid: value.canonical_device_uid || null,
        command_id: command.id || null,
        agent_id: command.agent_id || validated.value.agent_id
      }
    });

    return res.status(202).json({
      company_id: value.company_id || companyId,
      requested_device_uid: value.requested_device_uid || req.params.deviceUid,
      canonical_device_uid: value.canonical_device_uid || req.params.deviceUid,
      canonical_resolved_by: value.canonical_resolved_by || null,
      canonical_alias_kind: value.canonical_alias_kind || null,
      canonical_alias_status: value.canonical_alias_status || null,
      managed_status: value.managed_status || null,
      lifecycle_scope: value.lifecycle_scope || null,
      configuration_status: value.configuration_status || null,
      missing_required_fields: Array.isArray(value.missing_required_fields) ? value.missing_required_fields : [],
      ready_for_validation: value.ready_for_validation === true,
      validation_status: value.validation_status || null,
      validation_reason_code: value.validation_reason_code || null,
      onboarding_state: value.onboarding_state || null,
      command: command ? {
        id: command.id || null,
        company_id: command.company_id || companyId,
        agent_id: command.agent_id || validated.value.agent_id,
        command_type: command.command_type || null,
        status: command.status || null,
        created_at: command.created_at || null,
        expires_at: command.expires_at || null
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

router.get('/device-sync-states', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const rows = await listDeviceSyncStates(db, {
      companyId,
      agentId: req.query.agent_id,
      deviceUid: req.query.device_uid,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    logBridgeEvent('bridge.api.admin.device_sync_states.listed', {
      company_id: companyId,
      count: rows.length
    });
    return res.json({
      value: rows,
      count: rows.length
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

router.post('/discovered-devices/:deviceUid/claim', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;
    const deviceUid = req.params.deviceUid;
    const claimed = await claimCandidateDevice(db, {
      companyId,
      deviceUid,
      claimedByKeyId: req.ctx ? req.ctx.key_id_or_prefix : null,
      claimedByRole: req.ctx ? req.ctx.role : null,
      updates: body
    });
    if (!claimed) {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Candidate device not found',
        details: {
          kind: 'lookup_error',
          error: 'candidate_device_not_found'
        }
      });
    }
    logBridgeEvent('bridge.api.admin.discovered_device.claimed', {
      company_id: companyId,
      device_uid: claimed.device_uid,
      managed_status: claimed.managed_status,
      claimed_at: claimed.claimed_at
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.device.claim',
      target: req.originalUrl || req.path,
      metadata: {
        device_uid: claimed.device_uid
      }
    });

    return res.json(attachManageabilityView(claimed));
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.put('/devices/:deviceUid/managing-agent-binding', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    const companyId = resolved.value;
    const targetAgentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
    if (!targetAgentId) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'agent_id is required'
        }
      });
    }

    const metadata = (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata))
      ? body.metadata
      : {};
    const bindResult = await setManagingAgentBinding(db, {
      companyId,
      deviceUid: req.params.deviceUid,
      agentId: targetAgentId,
      boundByKeyId: req.ctx ? req.ctx.key_id_or_prefix : null,
      boundByRole: req.ctx ? req.ctx.role : null,
      reason: typeof body.reason === 'string' ? body.reason : null,
      metadata
    });

    if (bindResult.error) {
      const notFoundErrors = new Set(['device_not_found', 'agent_not_found']);
      const conflictErrors = new Set([
        'device_not_managed',
        'agent_not_active',
        'device_uid_superseded_without_canonical'
      ]);
      return sendError(res, {
        status: notFoundErrors.has(bindResult.error) ? 404 : (conflictErrors.has(bindResult.error) ? 409 : 400),
        code: notFoundErrors.has(bindResult.error)
          ? 'LOOKUP_NOT_FOUND'
          : (conflictErrors.has(bindResult.error) ? 'CONFLICT' : 'VALIDATION_ERROR'),
        message: notFoundErrors.has(bindResult.error)
          ? 'Not found'
          : (conflictErrors.has(bindResult.error) ? 'Conflict' : 'Validation failed'),
        details: {
          kind: notFoundErrors.has(bindResult.error)
            ? 'lookup_error'
            : (conflictErrors.has(bindResult.error) ? 'conflict' : 'validation'),
          error: bindResult.error,
          ...(bindResult.value ? bindResult.value : {})
        }
      });
    }

    const value = bindResult.value;
    const binding = value.binding || {};
    logBridgeEvent('bridge.api.admin.device.managing_agent_binding.updated', {
      company_id: companyId,
      device_uid: value.canonical_device_uid,
      requested_device_uid: value.requested_device_uid,
      agent_id: binding.agent_id || targetAgentId,
      binding_action: value.binding_action
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.device.managing_agent_binding.set',
      target: req.originalUrl || req.path,
      metadata: {
        requested_device_uid: value.requested_device_uid,
        canonical_device_uid: value.canonical_device_uid,
        agent_id: binding.agent_id || targetAgentId,
        binding_action: value.binding_action
      }
    });

    return res.json(value);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.put('/devices/:deviceUid/remediation', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }

    if (!Object.prototype.hasOwnProperty.call(body, 'remediation_status')) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'remediation_status is required (needs_field_action or null)'
        }
      });
    }

    if (body.remediation_status !== null && typeof body.remediation_status !== 'string') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'remediation_status must be a string or null'
        }
      });
    }

    const statusRaw = typeof body.remediation_status === 'string'
      ? body.remediation_status.trim().toLowerCase()
      : '';
    const isClear = body.remediation_status === null || statusRaw === '';
    const normalizedStatus = isClear ? 'clear' : statusRaw;
    if (!isClear && normalizedStatus !== MANUAL_REMEDIATION_STATUS.NEEDS_FIELD_ACTION) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'remediation_status must be needs_field_action or null'
        }
      });
    }

    const companyId = resolved.value;
    const deviceUid = req.params.deviceUid;
    const updated = await setManualDeviceRemediation(db, {
      companyId,
      deviceUid,
      manualStatus: normalizedStatus,
      manualNote: body.note,
      manualOwner: body.owner,
      updatedByKeyId: req.ctx ? req.ctx.key_id_or_prefix : null
    });

    if (updated.error === 'device_not_found') {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Device not found',
        details: {
          kind: 'lookup_error',
          error: 'device_not_found'
        }
      });
    }
    if (updated.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: updated.error
        }
      });
    }

    const row = attachManageabilityView(updated.value);
    logBridgeEvent('bridge.api.admin.device.remediation.updated', {
      company_id: companyId,
      device_uid: row.device_uid,
      remediation_manual_status: row.remediation_manual_status || null
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'agent_admin.device.remediation.update',
      target: req.originalUrl || req.path,
      metadata: {
        device_uid: row.device_uid,
        remediation_manual_status: row.remediation_manual_status || null
      }
    });

    return res.json(row);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

module.exports = router;

