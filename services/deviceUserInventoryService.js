function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

const INVENTORY_SCOPE = Object.freeze({
  ZK_K80: 'zk_k80'
});

const INVENTORY_CONFIDENCE_STATUS = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'unknown'
});

const INVENTORY_COMPLETENESS_STATUS = Object.freeze({
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  UNKNOWN: 'unknown'
});

const INVENTORY_CANDIDATE_STRATEGY = Object.freeze({
  ID: 'k80_max_plus_one_conservative_v1',
  MODE: 'max_plus_one'
});

const INVENTORY_CANDIDATE_STATUS = Object.freeze({
  READY: 'ready',
  BLOCKED_NO_SNAPSHOT: 'blocked_no_snapshot',
  BLOCKED_SCOPE_NOT_SUPPORTED: 'blocked_scope_not_supported',
  BLOCKED_INVALID_PARSED_IDS: 'blocked_invalid_parsed_ids',
  BLOCKED_INSUFFICIENT_CONFIDENCE: 'blocked_insufficient_confidence',
  BLOCKED_INSUFFICIENT_COMPLETENESS: 'blocked_insufficient_completeness',
  BLOCKED_CANDIDATE_COLLISION: 'blocked_candidate_collision',
  BLOCKED_CANDIDATE_OUT_OF_RANGE: 'blocked_candidate_out_of_range'
});

const ENROLLMENT_PREFLIGHT_STATUS = Object.freeze({
  READY_AUTO_CANDIDATE: 'ready_auto_candidate',
  READY_MANUAL_OVERRIDE: 'ready_manual_override',
  BLOCKED_REFRESH_INVENTORY_REQUIRED: 'blocked_refresh_inventory_required',
  BLOCKED_CONFIDENCE_INSUFFICIENT: 'blocked_confidence_insufficient',
  BLOCKED_INVALID_OVERRIDE: 'blocked_invalid_override'
});

const ENROLLMENT_PREFLIGHT_SELECTED_SOURCE = Object.freeze({
  AUTO_CANDIDATE: 'auto_candidate',
  MANUAL_OVERRIDE: 'manual_override'
});

function normalizeInventoryScope(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return INVENTORY_SCOPE.ZK_K80;
  }
  return normalized;
}

function normalizeConfidenceStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return INVENTORY_CONFIDENCE_STATUS.UNKNOWN;
  }
  if (Object.values(INVENTORY_CONFIDENCE_STATUS).includes(normalized)) {
    return normalized;
  }
  return INVENTORY_CONFIDENCE_STATUS.UNKNOWN;
}

function normalizeCompletenessStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return INVENTORY_COMPLETENESS_STATUS.UNKNOWN;
  }
  if (Object.values(INVENTORY_COMPLETENESS_STATUS).includes(normalized)) {
    return normalized;
  }
  return INVENTORY_COMPLETENESS_STATUS.UNKNOWN;
}

function normalizeSnapshotTakenAt(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  const raw = normalizeText(value);
  if (!raw) {
    return new Date().toISOString();
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function normalizeParsedDeviceUserIds(ids) {
  if (!Array.isArray(ids)) {
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (const value of ids) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      continue;
    }
    if (seen.has(parsed)) {
      continue;
    }
    seen.add(parsed);
    normalized.push(parsed);
  }
  normalized.sort((a, b) => a - b);
  return normalized;
}

function normalizeJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function normalizeCandidateId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function normalizeRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    company_id: row.company_id,
    device_uid: row.device_uid,
    inventory_scope: row.inventory_scope,
    snapshot_taken_at: row.snapshot_taken_at,
    raw_evidence_ref: row.raw_evidence_ref || {},
    parsed_device_user_ids: Array.isArray(row.parsed_device_user_ids) ? row.parsed_device_user_ids : [],
    parsed_user_count: Number.isInteger(row.parsed_user_count) ? row.parsed_user_count : null,
    inventory_confidence_status: row.inventory_confidence_status || INVENTORY_CONFIDENCE_STATUS.UNKNOWN,
    inventory_completeness_status: row.inventory_completeness_status || INVENTORY_COMPLETENESS_STATUS.UNKNOWN,
    next_candidate_device_user_id: Number.isInteger(row.next_candidate_device_user_id)
      ? row.next_candidate_device_user_id
      : null,
    allocation_strategy: row.allocation_strategy || null,
    strategy_version: row.strategy_version || null,
    notes: row.notes || null,
    source_metadata: row.source_metadata || {},
    superseded_by_snapshot_id: row.superseded_by_snapshot_id || null,
    created_by: row.created_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function buildBlockedCandidateResult({
  snapshot,
  status,
  reason,
  confidenceUsed,
  completenessUsed
}) {
  return {
    strategy_id: INVENTORY_CANDIDATE_STRATEGY.ID,
    strategy_mode: INVENTORY_CANDIDATE_STRATEGY.MODE,
    source_inventory_snapshot_id: snapshot ? snapshot.id : null,
    inventory_scope: snapshot ? snapshot.inventory_scope : INVENTORY_SCOPE.ZK_K80,
    candidate_readiness_status: status,
    blocked_reason_code: reason,
    candidate_device_user_id: null,
    confidence_used: confidenceUsed || INVENTORY_CONFIDENCE_STATUS.UNKNOWN,
    completeness_used: completenessUsed || INVENTORY_COMPLETENESS_STATUS.UNKNOWN,
    requires_manual_override: true
  };
}

function computeConservativeNextCandidateFromSnapshot(snapshot) {
  if (!snapshot) {
    return buildBlockedCandidateResult({
      snapshot: null,
      status: INVENTORY_CANDIDATE_STATUS.BLOCKED_NO_SNAPSHOT,
      reason: INVENTORY_CANDIDATE_STATUS.BLOCKED_NO_SNAPSHOT
    });
  }

  const normalizedScope = normalizeInventoryScope(snapshot.inventory_scope);
  const confidenceUsed = normalizeConfidenceStatus(snapshot.inventory_confidence_status);
  const completenessUsed = normalizeCompletenessStatus(snapshot.inventory_completeness_status);
  const parsedIds = normalizeParsedDeviceUserIds(snapshot.parsed_device_user_ids);

  if (normalizedScope !== INVENTORY_SCOPE.ZK_K80) {
    return buildBlockedCandidateResult({
      snapshot,
      status: INVENTORY_CANDIDATE_STATUS.BLOCKED_SCOPE_NOT_SUPPORTED,
      reason: INVENTORY_CANDIDATE_STATUS.BLOCKED_SCOPE_NOT_SUPPORTED,
      confidenceUsed,
      completenessUsed
    });
  }

  if (!parsedIds.length) {
    return buildBlockedCandidateResult({
      snapshot,
      status: INVENTORY_CANDIDATE_STATUS.BLOCKED_INVALID_PARSED_IDS,
      reason: INVENTORY_CANDIDATE_STATUS.BLOCKED_INVALID_PARSED_IDS,
      confidenceUsed,
      completenessUsed
    });
  }

  if (confidenceUsed !== INVENTORY_CONFIDENCE_STATUS.HIGH) {
    return buildBlockedCandidateResult({
      snapshot,
      status: INVENTORY_CANDIDATE_STATUS.BLOCKED_INSUFFICIENT_CONFIDENCE,
      reason: INVENTORY_CANDIDATE_STATUS.BLOCKED_INSUFFICIENT_CONFIDENCE,
      confidenceUsed,
      completenessUsed
    });
  }

  if (completenessUsed !== INVENTORY_COMPLETENESS_STATUS.COMPLETE) {
    return buildBlockedCandidateResult({
      snapshot,
      status: INVENTORY_CANDIDATE_STATUS.BLOCKED_INSUFFICIENT_COMPLETENESS,
      reason: INVENTORY_CANDIDATE_STATUS.BLOCKED_INSUFFICIENT_COMPLETENESS,
      confidenceUsed,
      completenessUsed
    });
  }

  const maxParsedId = parsedIds[parsedIds.length - 1];
  const candidate = maxParsedId + 1;
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > 2147483647) {
    return buildBlockedCandidateResult({
      snapshot,
      status: INVENTORY_CANDIDATE_STATUS.BLOCKED_CANDIDATE_OUT_OF_RANGE,
      reason: INVENTORY_CANDIDATE_STATUS.BLOCKED_CANDIDATE_OUT_OF_RANGE,
      confidenceUsed,
      completenessUsed
    });
  }

  if (parsedIds.includes(candidate)) {
    return buildBlockedCandidateResult({
      snapshot,
      status: INVENTORY_CANDIDATE_STATUS.BLOCKED_CANDIDATE_COLLISION,
      reason: INVENTORY_CANDIDATE_STATUS.BLOCKED_CANDIDATE_COLLISION,
      confidenceUsed,
      completenessUsed
    });
  }

  return {
    strategy_id: INVENTORY_CANDIDATE_STRATEGY.ID,
    strategy_mode: INVENTORY_CANDIDATE_STRATEGY.MODE,
    source_inventory_snapshot_id: snapshot.id,
    inventory_scope: normalizedScope,
    candidate_readiness_status: INVENTORY_CANDIDATE_STATUS.READY,
    blocked_reason_code: null,
    candidate_device_user_id: candidate,
    confidence_used: confidenceUsed,
    completeness_used: completenessUsed,
    requires_manual_override: false
  };
}

function normalizeManualOverrideInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      provided: false,
      device_user_id: null,
      override_reason: null,
      override_note: null
    };
  }
  const hasExplicitId = Object.prototype.hasOwnProperty.call(value, 'device_user_id');
  const rawDeviceUserId = hasExplicitId ? value.device_user_id : null;
  const parsedDeviceUserId = normalizeCandidateId(rawDeviceUserId);
  const reason = normalizeText(value.override_reason) || null;
  const note = normalizeText(value.override_note) || null;
  return {
    provided: hasExplicitId || Boolean(reason) || Boolean(note),
    hasExplicitId,
    device_user_id: parsedDeviceUserId,
    raw_device_user_id: rawDeviceUserId,
    override_reason: reason,
    override_note: note
  };
}

function evaluateEnrollmentPreflight({
  snapshot,
  candidateEvaluation,
  manualOverride
}) {
  const evaluation = candidateEvaluation || computeConservativeNextCandidateFromSnapshot(snapshot);
  const normalizedOverride = normalizeManualOverrideInput(manualOverride);
  const parsedIds = normalizeParsedDeviceUserIds(snapshot ? snapshot.parsed_device_user_ids : []);
  const knownUsedIds = new Set(parsedIds);
  const sourceSnapshotId = snapshot ? snapshot.id : null;

  if (!snapshot) {
    return {
      source_inventory_snapshot_id: null,
      source_candidate_evaluation: evaluation,
      selected_candidate_device_user_id: null,
      selected_source: null,
      preflight_readiness_status: ENROLLMENT_PREFLIGHT_STATUS.BLOCKED_REFRESH_INVENTORY_REQUIRED,
      blocked_reason_code: ENROLLMENT_PREFLIGHT_STATUS.BLOCKED_REFRESH_INVENTORY_REQUIRED,
      manual_override_used: false,
      manual_override_actor: null,
      manual_override_reason: null,
      manual_override_note: null,
      manual_override_required: true,
      audit_ref: null,
      evaluated_at: new Date().toISOString()
    };
  }

  if (normalizedOverride.provided) {
    if (!normalizedOverride.hasExplicitId || normalizedOverride.device_user_id === null) {
      return {
        source_inventory_snapshot_id: sourceSnapshotId,
        source_candidate_evaluation: evaluation,
        selected_candidate_device_user_id: null,
        selected_source: null,
        preflight_readiness_status: ENROLLMENT_PREFLIGHT_STATUS.BLOCKED_INVALID_OVERRIDE,
        blocked_reason_code: 'manual_override_invalid_device_user_id',
        manual_override_used: true,
        manual_override_actor: null,
        manual_override_reason: normalizedOverride.override_reason,
        manual_override_note: normalizedOverride.override_note,
        manual_override_required: true,
        audit_ref: null,
        evaluated_at: new Date().toISOString()
      };
    }

    if (!parsedIds.length) {
      return {
        source_inventory_snapshot_id: sourceSnapshotId,
        source_candidate_evaluation: evaluation,
        selected_candidate_device_user_id: null,
        selected_source: null,
        preflight_readiness_status: ENROLLMENT_PREFLIGHT_STATUS.BLOCKED_REFRESH_INVENTORY_REQUIRED,
        blocked_reason_code: 'manual_override_requires_inventory_refresh',
        manual_override_used: true,
        manual_override_actor: null,
        manual_override_reason: normalizedOverride.override_reason,
        manual_override_note: normalizedOverride.override_note,
        manual_override_required: true,
        audit_ref: null,
        evaluated_at: new Date().toISOString()
      };
    }

    if (knownUsedIds.has(normalizedOverride.device_user_id)) {
      return {
        source_inventory_snapshot_id: sourceSnapshotId,
        source_candidate_evaluation: evaluation,
        selected_candidate_device_user_id: null,
        selected_source: null,
        preflight_readiness_status: ENROLLMENT_PREFLIGHT_STATUS.BLOCKED_INVALID_OVERRIDE,
        blocked_reason_code: 'manual_override_collides_with_known_device_user_id',
        manual_override_used: true,
        manual_override_actor: null,
        manual_override_reason: normalizedOverride.override_reason,
        manual_override_note: normalizedOverride.override_note,
        manual_override_required: true,
        audit_ref: null,
        evaluated_at: new Date().toISOString()
      };
    }

    return {
      source_inventory_snapshot_id: sourceSnapshotId,
      source_candidate_evaluation: evaluation,
      selected_candidate_device_user_id: normalizedOverride.device_user_id,
      selected_source: ENROLLMENT_PREFLIGHT_SELECTED_SOURCE.MANUAL_OVERRIDE,
      preflight_readiness_status: ENROLLMENT_PREFLIGHT_STATUS.READY_MANUAL_OVERRIDE,
      blocked_reason_code: null,
      manual_override_used: true,
      manual_override_actor: null,
      manual_override_reason: normalizedOverride.override_reason,
      manual_override_note: normalizedOverride.override_note,
      manual_override_required: false,
      audit_ref: null,
      evaluated_at: new Date().toISOString()
    };
  }

  if (evaluation.candidate_readiness_status === INVENTORY_CANDIDATE_STATUS.READY) {
    return {
      source_inventory_snapshot_id: sourceSnapshotId,
      source_candidate_evaluation: evaluation,
      selected_candidate_device_user_id: evaluation.candidate_device_user_id,
      selected_source: ENROLLMENT_PREFLIGHT_SELECTED_SOURCE.AUTO_CANDIDATE,
      preflight_readiness_status: ENROLLMENT_PREFLIGHT_STATUS.READY_AUTO_CANDIDATE,
      blocked_reason_code: null,
      manual_override_used: false,
      manual_override_actor: null,
      manual_override_reason: null,
      manual_override_note: null,
      manual_override_required: false,
      audit_ref: null,
      evaluated_at: new Date().toISOString()
    };
  }

  if (evaluation.candidate_readiness_status === INVENTORY_CANDIDATE_STATUS.BLOCKED_INSUFFICIENT_CONFIDENCE) {
    return {
      source_inventory_snapshot_id: sourceSnapshotId,
      source_candidate_evaluation: evaluation,
      selected_candidate_device_user_id: null,
      selected_source: null,
      preflight_readiness_status: ENROLLMENT_PREFLIGHT_STATUS.BLOCKED_CONFIDENCE_INSUFFICIENT,
      blocked_reason_code: ENROLLMENT_PREFLIGHT_STATUS.BLOCKED_CONFIDENCE_INSUFFICIENT,
      manual_override_used: false,
      manual_override_actor: null,
      manual_override_reason: null,
      manual_override_note: null,
      manual_override_required: true,
      audit_ref: null,
      evaluated_at: new Date().toISOString()
    };
  }

  return {
    source_inventory_snapshot_id: sourceSnapshotId,
    source_candidate_evaluation: evaluation,
    selected_candidate_device_user_id: null,
    selected_source: null,
    preflight_readiness_status: ENROLLMENT_PREFLIGHT_STATUS.BLOCKED_REFRESH_INVENTORY_REQUIRED,
    blocked_reason_code: evaluation.blocked_reason_code || ENROLLMENT_PREFLIGHT_STATUS.BLOCKED_REFRESH_INVENTORY_REQUIRED,
    manual_override_used: false,
    manual_override_actor: null,
    manual_override_reason: null,
    manual_override_note: null,
    manual_override_required: true,
    audit_ref: null,
    evaluated_at: new Date().toISOString()
  };
}

async function createEnrollmentPreflightDecision(db, {
  companyId,
  deviceUid,
  inventoryScope,
  sourceInventorySnapshotId,
  sourceCandidateEvaluation,
  selectedCandidateDeviceUserId,
  selectedSource,
  preflightReadinessStatus,
  blockedReasonCode,
  manualOverrideUsed,
  manualOverrideActor,
  manualOverrideReason,
  manualOverrideNote,
  manualOverrideRequired,
  auditRef,
  evaluatedAt,
  metadata
}) {
  const normalizedScope = normalizeInventoryScope(inventoryScope);
  const normalizedSelectedCandidate = normalizeCandidateId(selectedCandidateDeviceUserId);
  const normalizedSelectedSource = normalizeText(selectedSource) || null;
  const normalizedReadiness = normalizeText(preflightReadinessStatus) || ENROLLMENT_PREFLIGHT_STATUS.BLOCKED_REFRESH_INVENTORY_REQUIRED;
  const normalizedBlockedReason = normalizeText(blockedReasonCode) || null;
  const normalizedManualOverrideActor = normalizeText(manualOverrideActor) || null;
  const normalizedManualOverrideReason = normalizeText(manualOverrideReason) || null;
  const normalizedManualOverrideNote = normalizeText(manualOverrideNote) || null;
  const normalizedAuditRef = normalizeText(auditRef) || null;
  const normalizedEvaluatedAt = normalizeSnapshotTakenAt(evaluatedAt);
  const normalizedMetadata = normalizeJsonObject(metadata);
  const normalizedCandidateEvaluation = normalizeJsonObject(sourceCandidateEvaluation);

  const result = await db.query(
    `
    INSERT INTO device_user_id_preflight_decisions (
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
      metadata
    )
    VALUES (
      $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17::jsonb
    )
    RETURNING
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
    `,
    [
      companyId,
      deviceUid,
      normalizedScope,
      sourceInventorySnapshotId || null,
      JSON.stringify(normalizedCandidateEvaluation),
      normalizedSelectedCandidate,
      normalizedSelectedSource,
      normalizedReadiness,
      normalizedBlockedReason,
      manualOverrideUsed === true,
      normalizedManualOverrideActor,
      normalizedManualOverrideReason,
      normalizedManualOverrideNote,
      manualOverrideRequired === true,
      normalizedAuditRef,
      normalizedEvaluatedAt,
      JSON.stringify(normalizedMetadata)
    ]
  );
  return result.rows[0] || null;
}

async function createDeviceUserInventorySnapshot(db, {
  companyId,
  deviceUid,
  inventoryScope,
  snapshotTakenAt,
  rawEvidenceRef,
  parsedDeviceUserIds,
  inventoryConfidenceStatus,
  inventoryCompletenessStatus,
  nextCandidateDeviceUserId,
  allocationStrategy,
  strategyVersion,
  notes,
  sourceMetadata,
  createdBy
}) {
  const normalizedScope = normalizeInventoryScope(inventoryScope);
  const normalizedSnapshotTakenAt = normalizeSnapshotTakenAt(snapshotTakenAt);
  const normalizedRawEvidenceRef = normalizeJsonObject(rawEvidenceRef);
  const normalizedParsedIds = normalizeParsedDeviceUserIds(parsedDeviceUserIds);
  const normalizedConfidence = normalizeConfidenceStatus(inventoryConfidenceStatus);
  const normalizedCompleteness = normalizeCompletenessStatus(inventoryCompletenessStatus);
  const normalizedCandidate = normalizeCandidateId(nextCandidateDeviceUserId);
  const normalizedAllocationStrategy = normalizeText(allocationStrategy) || null;
  const normalizedStrategyVersion = normalizeText(strategyVersion) || null;
  const normalizedNotes = normalizeText(notes) || null;
  const normalizedSourceMetadata = normalizeJsonObject(sourceMetadata);
  const normalizedCreatedBy = normalizeText(createdBy) || null;

  const result = await db.query(
    `
    INSERT INTO device_user_inventory_snapshots (
      company_id,
      device_uid,
      inventory_scope,
      snapshot_taken_at,
      raw_evidence_ref,
      parsed_device_user_ids,
      parsed_user_count,
      inventory_confidence_status,
      inventory_completeness_status,
      next_candidate_device_user_id,
      allocation_strategy,
      strategy_version,
      notes,
      source_metadata,
      created_by
    )
    VALUES (
      $1, $2, $3, $4::timestamptz, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15
    )
    RETURNING
      id,
      company_id,
      device_uid,
      inventory_scope,
      snapshot_taken_at,
      raw_evidence_ref,
      parsed_device_user_ids,
      parsed_user_count,
      inventory_confidence_status,
      inventory_completeness_status,
      next_candidate_device_user_id,
      allocation_strategy,
      strategy_version,
      notes,
      source_metadata,
      superseded_by_snapshot_id,
      created_by,
      created_at,
      updated_at
    `,
    [
      companyId,
      deviceUid,
      normalizedScope,
      normalizedSnapshotTakenAt,
      JSON.stringify(normalizedRawEvidenceRef),
      JSON.stringify(normalizedParsedIds),
      normalizedParsedIds.length,
      normalizedConfidence,
      normalizedCompleteness,
      normalizedCandidate,
      normalizedAllocationStrategy,
      normalizedStrategyVersion,
      normalizedNotes,
      JSON.stringify(normalizedSourceMetadata),
      normalizedCreatedBy
    ]
  );

  return normalizeRow(result.rows[0]);
}

async function getLatestDeviceUserInventorySnapshot(db, {
  companyId,
  deviceUid,
  inventoryScope
}) {
  const normalizedScope = normalizeInventoryScope(inventoryScope);
  const result = await db.query(
    `
    SELECT
      id,
      company_id,
      device_uid,
      inventory_scope,
      snapshot_taken_at,
      raw_evidence_ref,
      parsed_device_user_ids,
      parsed_user_count,
      inventory_confidence_status,
      inventory_completeness_status,
      next_candidate_device_user_id,
      allocation_strategy,
      strategy_version,
      notes,
      source_metadata,
      superseded_by_snapshot_id,
      created_by,
      created_at,
      updated_at
    FROM device_user_inventory_snapshots
    WHERE company_id = $1
      AND device_uid = $2
      AND inventory_scope = $3
    ORDER BY snapshot_taken_at DESC, created_at DESC
    LIMIT 1
    `,
    [companyId, deviceUid, normalizedScope]
  );
  return normalizeRow(result.rows[0] || null);
}

module.exports = {
  INVENTORY_SCOPE,
  INVENTORY_CONFIDENCE_STATUS,
  INVENTORY_COMPLETENESS_STATUS,
  INVENTORY_CANDIDATE_STRATEGY,
  INVENTORY_CANDIDATE_STATUS,
  ENROLLMENT_PREFLIGHT_STATUS,
  ENROLLMENT_PREFLIGHT_SELECTED_SOURCE,
  normalizeInventoryScope,
  normalizeConfidenceStatus,
  normalizeCompletenessStatus,
  normalizeParsedDeviceUserIds,
  computeConservativeNextCandidateFromSnapshot,
  evaluateEnrollmentPreflight,
  createDeviceUserInventorySnapshot,
  getLatestDeviceUserInventorySnapshot,
  createEnrollmentPreflightDecision
};
