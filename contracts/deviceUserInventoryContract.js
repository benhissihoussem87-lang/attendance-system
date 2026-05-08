const {
  INVENTORY_SCOPE,
  INVENTORY_CONFIDENCE_STATUS,
  INVENTORY_COMPLETENESS_STATUS,
  normalizeInventoryScope,
  normalizeConfidenceStatus,
  normalizeCompletenessStatus,
  normalizeParsedDeviceUserIds
} = require('../services/deviceUserInventoryService');

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parseOptionalIsoDate(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return { value: null };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { error: 'snapshot_taken_at must be a valid ISO date-time' };
  }
  return { value: parsed.toISOString() };
}

function parseOptionalCandidateId(value) {
  if (value === null || value === undefined || value === '') {
    return { value: null };
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { error: 'next_candidate_device_user_id must be a non-negative integer when provided' };
  }
  return { value: parsed };
}

function validateInventorySnapshotCreatePayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }

  const parsedIds = normalizeParsedDeviceUserIds(payload.parsed_device_user_ids);
  const scope = normalizeInventoryScope(payload.inventory_scope);
  if (scope !== INVENTORY_SCOPE.ZK_K80) {
    return { ok: false, error: 'inventory_scope must be zk_k80 in this phase' };
  }

  const confidence = normalizeConfidenceStatus(payload.inventory_confidence_status);
  if (!Object.values(INVENTORY_CONFIDENCE_STATUS).includes(confidence)) {
    return { ok: false, error: 'inventory_confidence_status is invalid' };
  }

  const completeness = normalizeCompletenessStatus(payload.inventory_completeness_status);
  if (!Object.values(INVENTORY_COMPLETENESS_STATUS).includes(completeness)) {
    return { ok: false, error: 'inventory_completeness_status is invalid' };
  }

  const snapshotTakenAt = parseOptionalIsoDate(payload.snapshot_taken_at);
  if (snapshotTakenAt.error) {
    return { ok: false, error: snapshotTakenAt.error };
  }

  const candidateId = parseOptionalCandidateId(payload.next_candidate_device_user_id);
  if (candidateId.error) {
    return { ok: false, error: candidateId.error };
  }

  const rawEvidenceRef = isPlainObject(payload.raw_evidence_ref) ? payload.raw_evidence_ref : {};
  const sourceMetadata = isPlainObject(payload.source_metadata) ? payload.source_metadata : {};
  const allocationStrategy = normalizeText(payload.allocation_strategy) || null;
  const strategyVersion = normalizeText(payload.strategy_version) || null;
  const notes = normalizeText(payload.notes) || null;
  const createdBy = normalizeText(payload.created_by) || null;

  return {
    ok: true,
    value: {
      inventory_scope: scope,
      snapshot_taken_at: snapshotTakenAt.value,
      raw_evidence_ref: rawEvidenceRef,
      parsed_device_user_ids: parsedIds,
      inventory_confidence_status: confidence,
      inventory_completeness_status: completeness,
      next_candidate_device_user_id: candidateId.value,
      allocation_strategy: allocationStrategy,
      strategy_version: strategyVersion,
      notes,
      source_metadata: sourceMetadata,
      created_by: createdBy
    }
  };
}

function validateEnrollmentPreflightPayload(payload) {
  if (payload === null || payload === undefined) {
    return {
      ok: true,
      value: {
        manual_override: null,
        note: null
      }
    };
  }
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }

  let manualOverride = null;
  if (Object.prototype.hasOwnProperty.call(payload, 'manual_override')) {
    const raw = payload.manual_override;
    if (raw === null) {
      manualOverride = null;
    } else if (!isPlainObject(raw)) {
      return { ok: false, error: 'manual_override must be an object when provided' };
    } else {
      const deviceUserIdResult = parseOptionalCandidateId(raw.device_user_id);
      if (deviceUserIdResult.error) {
        return { ok: false, error: `manual_override.${deviceUserIdResult.error}` };
      }
      manualOverride = {
        device_user_id: deviceUserIdResult.value,
        override_reason: normalizeText(raw.override_reason) || null,
        override_note: normalizeText(raw.override_note) || null
      };
    }
  }

  return {
    ok: true,
    value: {
      manual_override: manualOverride,
      note: normalizeText(payload.note) || null
    }
  };
}

module.exports = {
  validateInventorySnapshotCreatePayload,
  validateEnrollmentPreflightPayload
};
