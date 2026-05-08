const MANAGEABILITY_STATUS = Object.freeze({
  UNKNOWN: 'unknown',
  REACHABLE: 'reachable',
  PROTOCOL_REACHABLE: 'protocol_reachable',
  BLOCKED: 'blocked',
  MANAGEABLE: 'manageable',
  INGESTING: 'ingesting'
});

const MANUAL_REMEDIATION_STATUS = Object.freeze({
  NEEDS_FIELD_ACTION: 'needs_field_action'
});

const MANAGEABILITY_REASON = Object.freeze({
  DISCOVERY_HOST_REACHABLE: 'discovery_host_reachable',
  DISCOVERY_PROTOCOL_REACHABLE: 'discovery_protocol_reachable',
  DISCOVERY_CONFIRMED: 'discovery_confirmed',
  NETWORK_UNREACHABLE: 'network_unreachable',
  TIMEOUT: 'timeout',
  CONNECT_TIMEOUT: 'connect_timeout',
  AUTH_REQUIRED: 'auth_required',
  AUTH_FAILED: 'auth_failed',
  PROTOCOL_ERROR: 'protocol_error',
  MALFORMED_RESPONSE: 'malformed_response',
  SOCKET_ERROR: 'socket_error',
  ATTLOG_TIMEOUT: 'attlog_timeout',
  ATTLOG_ERROR: 'attlog_error',
  EMPTY_DATA: 'empty_data',
  MISSING_HOST: 'missing_host',
  UNSUPPORTED_VENDOR: 'unsupported_vendor',
  PULL_FAILED: 'pull_failed',
  INGESTION_REJECTED: 'ingestion_rejected',
  PULL_SUCCEEDED: 'pull_succeeded',
  INGESTION_ACCEPTED: 'ingestion_accepted',
  MANUAL_NEEDS_FIELD_ACTION: 'manual_needs_field_action',
  UNKNOWN_ERROR: 'unknown_error'
});

const MANAGEABILITY_REASON_VALUES = new Set(Object.values(MANAGEABILITY_REASON));

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeManageabilityReason(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) {
    return null;
  }
  if (MANAGEABILITY_REASON_VALUES.has(raw)) {
    return raw;
  }
  if (raw.startsWith('connect_ack_') || raw.startsWith('attlog_ack_')) {
    return MANAGEABILITY_REASON.PROTOCOL_ERROR;
  }
  if (raw.includes('network_unreachable') || raw.includes('host_unreachable')) {
    return MANAGEABILITY_REASON.NETWORK_UNREACHABLE;
  }
  if (raw === 'timeout') {
    return MANAGEABILITY_REASON.TIMEOUT;
  }
  if (raw.includes('connect_timeout')) {
    return MANAGEABILITY_REASON.CONNECT_TIMEOUT;
  }
  if (raw.includes('attlog_timeout')) {
    return MANAGEABILITY_REASON.ATTLOG_TIMEOUT;
  }
  if (raw.includes('auth_required')) {
    return MANAGEABILITY_REASON.AUTH_REQUIRED;
  }
  if (raw.includes('auth_failed')) {
    return MANAGEABILITY_REASON.AUTH_FAILED;
  }
  if (raw.includes('attlog_error')) {
    return MANAGEABILITY_REASON.ATTLOG_ERROR;
  }
  if (raw.includes('empty_data')) {
    return MANAGEABILITY_REASON.EMPTY_DATA;
  }
  if (raw.includes('protocol') || raw.includes('ack_')) {
    return MANAGEABILITY_REASON.PROTOCOL_ERROR;
  }
  if (raw.includes('malformed')) {
    return MANAGEABILITY_REASON.MALFORMED_RESPONSE;
  }
  if (raw.includes('socket')) {
    return MANAGEABILITY_REASON.SOCKET_ERROR;
  }
  if (raw.includes('missing_host')) {
    return MANAGEABILITY_REASON.MISSING_HOST;
  }
  if (raw.includes('unsupported_vendor')) {
    return MANAGEABILITY_REASON.UNSUPPORTED_VENDOR;
  }
  return MANAGEABILITY_REASON.UNKNOWN_ERROR;
}

function mapDiscoveryOutcomeToManageability({ confirmationState, failureReason }) {
  const normalizedFailure = normalizeManageabilityReason(failureReason);
  if (normalizedFailure) {
    return {
      status: MANAGEABILITY_STATUS.BLOCKED,
      reason: normalizedFailure,
      proven: false
    };
  }

  const state = normalizeText(confirmationState).toLowerCase();
  if (state === 'host_reachable') {
    return {
      status: MANAGEABILITY_STATUS.REACHABLE,
      reason: MANAGEABILITY_REASON.DISCOVERY_HOST_REACHABLE,
      proven: false
    };
  }
  if (state === 'zk_service_reachable') {
    return {
      status: MANAGEABILITY_STATUS.PROTOCOL_REACHABLE,
      reason: MANAGEABILITY_REASON.DISCOVERY_PROTOCOL_REACHABLE,
      proven: false
    };
  }
  if (state === 'confirmed') {
    return {
      status: MANAGEABILITY_STATUS.PROTOCOL_REACHABLE,
      reason: MANAGEABILITY_REASON.DISCOVERY_CONFIRMED,
      proven: false
    };
  }

  return {
    status: MANAGEABILITY_STATUS.UNKNOWN,
    reason: null,
    proven: false
  };
}

function mapPullOutcomeToManageability({
  batchStatus,
  pullOk,
  insertedCount,
  dedupedCount,
  failureReason
}) {
  const status = normalizeText(batchStatus).toLowerCase();
  const acceptedEvidenceCount = Math.max(0, Number(insertedCount) || 0) + Math.max(0, Number(dedupedCount) || 0);
  const normalizedFailure = normalizeManageabilityReason(failureReason);

  if (status === 'accepted' || status === 'partial') {
    if (acceptedEvidenceCount > 0) {
      return {
        status: MANAGEABILITY_STATUS.INGESTING,
        reason: MANAGEABILITY_REASON.INGESTION_ACCEPTED,
        proven: true
      };
    }
    if (pullOk === true) {
      return {
        status: MANAGEABILITY_STATUS.MANAGEABLE,
        reason: MANAGEABILITY_REASON.PULL_SUCCEEDED,
        proven: true
      };
    }
  }

  if (status === 'rejected' || pullOk === false || normalizedFailure) {
    return {
      status: MANAGEABILITY_STATUS.BLOCKED,
      reason: normalizedFailure || (status === 'rejected'
        ? MANAGEABILITY_REASON.INGESTION_REJECTED
        : MANAGEABILITY_REASON.PULL_FAILED),
      proven: false
    };
  }

  return {
    status: MANAGEABILITY_STATUS.UNKNOWN,
    reason: null,
    proven: false
  };
}

function buildManageabilityView(row) {
  const source = row && typeof row === 'object' ? row : {};
  const systemStatusRaw = normalizeText(source.manageability_status).toLowerCase();
  const systemStatus = systemStatusRaw || MANAGEABILITY_STATUS.UNKNOWN;
  const systemReason = normalizeManageabilityReason(source.manageability_reason);
  const manualStatusRaw = normalizeText(source.remediation_manual_status).toLowerCase();
  const manualStatus = manualStatusRaw || null;
  const manualActive = manualStatus === MANUAL_REMEDIATION_STATUS.NEEDS_FIELD_ACTION;

  return {
    effective_status: manualActive ? manualStatus : systemStatus,
    effective_reason: manualActive ? MANAGEABILITY_REASON.MANUAL_NEEDS_FIELD_ACTION : systemReason,
    system_status: systemStatus,
    system_reason: systemReason,
    manual_status: manualStatus,
    manual_note: source.remediation_manual_note || null,
    manual_owner: source.remediation_manual_owner || null,
    manual_updated_at: source.remediation_manual_updated_at || null,
    manual_updated_by_key_id: source.remediation_manual_updated_by_key_id || null,
    last_proven_at: source.manageability_last_proven_at || null,
    updated_at: source.manageability_updated_at || null,
    is_proven_manageable: systemStatus === MANAGEABILITY_STATUS.MANAGEABLE
      || systemStatus === MANAGEABILITY_STATUS.INGESTING
  };
}

function attachManageabilityView(row) {
  if (!row || typeof row !== 'object') {
    return row;
  }
  return {
    ...row,
    manageability: buildManageabilityView(row)
  };
}

module.exports = {
  MANAGEABILITY_STATUS,
  MANUAL_REMEDIATION_STATUS,
  MANAGEABILITY_REASON,
  MANAGEABILITY_REASON_VALUES,
  normalizeManageabilityReason,
  mapDiscoveryOutcomeToManageability,
  mapPullOutcomeToManageability,
  buildManageabilityView,
  attachManageabilityView
};
