const crypto = require('crypto');
const {
  INVENTORY_SCOPE,
  normalizeInventoryScope,
  ENROLLMENT_PREFLIGHT_STATUS
} = require('./deviceUserInventoryService');

const ENROLLMENT_ATTEMPT_STATUS = Object.freeze({
  PENDING: 'pending',
  STARTING: 'starting',
  IN_PROGRESS: 'in_progress',
  SUCCESS: 'success',
  CANCELLED: 'cancelled',
  PARTIAL_OR_FAILED: 'partial_or_failed',
  BLOCKED: 'blocked'
});

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function normalizeAttemptRow(row) {
  if (!row) {
    return null;
  }
  const sourceMetadata = row.source_metadata || {};
  const protocolExecutionState = normalizeText(sourceMetadata.protocol_execution_state).toLowerCase() || 'not_started';
  return {
    id: row.id,
    company_id: row.company_id,
    device_uid: row.device_uid,
    inventory_scope: row.inventory_scope,
    person_id: row.person_id,
    device_user_id: Number.isInteger(row.device_user_id) ? row.device_user_id : null,
    selected_finger: row.selected_finger,
    preflight_decision_id: row.preflight_decision_id,
    attempt_status: row.attempt_status,
    status_reason: row.status_reason || null,
    protocol_session_ref: row.protocol_session_ref || null,
    command_ref: row.command_ref || null,
    evidence_ref: row.evidence_ref || {},
    source_metadata: sourceMetadata,
    protocol_execution_state: protocolExecutionState,
    started_at: row.started_at,
    ended_at: row.ended_at || null,
    created_by: row.created_by || null,
    audit_ref: row.audit_ref || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function getLatestEnrollmentPreflightDecision(db, {
  companyId,
  deviceUid,
  inventoryScope
}) {
  const scope = normalizeInventoryScope(inventoryScope);
  const result = await db.query(
    `
    SELECT
      id,
      company_id,
      device_uid,
      inventory_scope,
      source_inventory_snapshot_id,
      source_candidate_evaluation,
      selected_candidate_device_user_id,
      selected_source,
      preflight_readiness_status,
      blocked_reason_code,
      manual_override_used,
      manual_override_actor,
      manual_override_reason,
      manual_override_note,
      manual_override_required,
      audit_ref,
      evaluated_at,
      metadata,
      created_at
    FROM device_user_id_preflight_decisions
    WHERE company_id = $1
      AND device_uid = $2
      AND inventory_scope = $3
    ORDER BY evaluated_at DESC, created_at DESC
    LIMIT 1
    `,
    [companyId, deviceUid, scope]
  );
  return result.rows[0] || null;
}

async function getEnrollmentPreflightDecisionById(db, {
  companyId,
  preflightDecisionId
}) {
  const result = await db.query(
    `
    SELECT
      id,
      company_id,
      device_uid,
      inventory_scope,
      source_inventory_snapshot_id,
      source_candidate_evaluation,
      selected_candidate_device_user_id,
      selected_source,
      preflight_readiness_status,
      blocked_reason_code,
      manual_override_used,
      manual_override_actor,
      manual_override_reason,
      manual_override_note,
      manual_override_required,
      audit_ref,
      evaluated_at,
      metadata,
      created_at
    FROM device_user_id_preflight_decisions
    WHERE company_id = $1
      AND id = $2::uuid
    LIMIT 1
    `,
    [companyId, preflightDecisionId]
  );
  return result.rows[0] || null;
}

function isPreflightReadyStatus(status) {
  return status === ENROLLMENT_PREFLIGHT_STATUS.READY_AUTO_CANDIDATE
    || status === ENROLLMENT_PREFLIGHT_STATUS.READY_MANUAL_OVERRIDE;
}

function validatePreflightForEnrollmentStart({
  canonicalDeviceUid,
  inventoryScope,
  latestDecision,
  selectedDecision
}) {
  if (!selectedDecision) {
    return { error: 'preflight_decision_not_found' };
  }
  if (selectedDecision.device_uid !== canonicalDeviceUid) {
    return { error: 'preflight_decision_device_mismatch' };
  }
  if (normalizeInventoryScope(selectedDecision.inventory_scope) !== normalizeInventoryScope(inventoryScope)) {
    return { error: 'preflight_decision_scope_mismatch' };
  }
  if (!latestDecision || latestDecision.id !== selectedDecision.id) {
    return { error: 'preflight_decision_not_latest' };
  }
  if (!isPreflightReadyStatus(selectedDecision.preflight_readiness_status)) {
    return { error: 'preflight_decision_not_ready' };
  }
  if (!Number.isInteger(selectedDecision.selected_candidate_device_user_id)) {
    return { error: 'preflight_decision_missing_candidate' };
  }
  return {
    value: {
      selected_device_user_id: selectedDecision.selected_candidate_device_user_id,
      selected_source: selectedDecision.selected_source || null
    }
  };
}

async function createEnrollmentAttempt(db, {
  companyId,
  deviceUid,
  inventoryScope,
  personId,
  deviceUserId,
  selectedFinger,
  preflightDecisionId,
  createdBy,
  sourceMetadata
}) {
  const auditRef = crypto.randomUUID();
  const normalizedScope = normalizeInventoryScope(inventoryScope);
  const normalizedPersonId = normalizeText(personId);
  const normalizedFinger = normalizeText(selectedFinger).toUpperCase();
  const normalizedCreatedBy = normalizeText(createdBy) || null;
  const normalizedSourceMetadata = normalizeJsonObject(sourceMetadata);
  const startedAt = new Date().toISOString();

  const result = await db.query(
    `
    INSERT INTO device_enrollment_attempts (
      company_id,
      device_uid,
      inventory_scope,
      person_id,
      device_user_id,
      selected_finger,
      preflight_decision_id,
      attempt_status,
      status_reason,
      protocol_session_ref,
      command_ref,
      evidence_ref,
      source_metadata,
      started_at,
      ended_at,
      created_by,
      audit_ref
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7::uuid, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::timestamptz, NULL, $15, $16
    )
    RETURNING
      id,
      company_id,
      device_uid,
      inventory_scope,
      person_id,
      device_user_id,
      selected_finger,
      preflight_decision_id,
      attempt_status,
      status_reason,
      protocol_session_ref,
      command_ref,
      evidence_ref,
      source_metadata,
      started_at,
      ended_at,
      created_by,
      audit_ref,
      created_at,
      updated_at
    `,
    [
      companyId,
      deviceUid,
      normalizedScope,
      normalizedPersonId,
      deviceUserId,
      normalizedFinger,
      preflightDecisionId,
      ENROLLMENT_ATTEMPT_STATUS.PENDING,
      'awaiting_k80_protocol_execution',
      null,
      null,
      JSON.stringify({}),
      JSON.stringify(normalizedSourceMetadata),
      startedAt,
      normalizedCreatedBy,
      auditRef
    ]
  );
  return normalizeAttemptRow(result.rows[0] || null);
}

async function getEnrollmentAttemptById(db, {
  companyId,
  enrollmentAttemptId
}) {
  const result = await db.query(
    `
    SELECT
      id,
      company_id,
      device_uid,
      inventory_scope,
      person_id,
      device_user_id,
      selected_finger,
      preflight_decision_id,
      attempt_status,
      status_reason,
      protocol_session_ref,
      command_ref,
      evidence_ref,
      source_metadata,
      started_at,
      ended_at,
      created_by,
      audit_ref,
      created_at,
      updated_at
    FROM device_enrollment_attempts
    WHERE company_id = $1
      AND id = $2::uuid
    LIMIT 1
    `,
    [companyId, enrollmentAttemptId]
  );
  return normalizeAttemptRow(result.rows[0] || null);
}

module.exports = {
  ENROLLMENT_ATTEMPT_STATUS,
  getLatestEnrollmentPreflightDecision,
  getEnrollmentPreflightDecisionById,
  validatePreflightForEnrollmentStart,
  createEnrollmentAttempt,
  getEnrollmentAttemptById
};
