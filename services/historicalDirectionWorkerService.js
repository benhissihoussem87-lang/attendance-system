const crypto = require('crypto');
const { normalizeText } = require('./agentAuth');
const {
  resolveDirectionAuthorityStrategy,
  resolveEffectiveDirectionAuthorityStrategyBehavior
} = require('./directionAuthorityStrategyResolver');
const {
  DIRECTION_HISTORICAL_STATUS,
  DIRECTION_HISTORICAL_STOP_REASON
} = require('./directionHistoricalStateService');

const DERIVATION_VERSION = 'k80_hist_v1';
const OUTCOME = Object.freeze({
  USABLE: 'usable',
  INFORMATIONAL_ONLY: 'informational_only',
  UNRESOLVED: 'unresolved'
});

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeIsoUtc(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString();
  }
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function parseMetadata(value) {
  if (!value) {
    return {};
  }
  if (isPlainObject(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch (err) {
      return {};
    }
  }
  return {};
}

function parseRtTimeContract(sourceMetadata) {
  const metadata = parseMetadata(sourceMetadata);
  return {
    version: normalizeText(metadata.rt_time_contract_version).toLowerCase(),
    observed_trust: normalizeText(metadata.rt_time_observed_trust).toLowerCase(),
    observed_basis: normalizeText(metadata.rt_time_observed_basis).toLowerCase()
  };
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseLaneState(value) {
  const source = isPlainObject(value) ? value : {};
  return {
    status: normalizeText(source.status).toLowerCase() || DIRECTION_HISTORICAL_STATUS.IDLE,
    session_id: normalizeText(source.session_id) || null,
    window_before_utc_exclusive: normalizeIsoUtc(source.window_before_utc_exclusive),
    window_before_anchor_key: normalizeText(source.window_before_anchor_key) || null,
    last_processed_utc: normalizeIsoUtc(source.last_processed_utc),
    last_artifact_fingerprint: normalizeText(source.last_artifact_fingerprint) || null,
    last_artifact_count: parseNonNegativeInt(source.last_artifact_count, 0),
    no_progress_windows: parseNonNegativeInt(source.no_progress_windows, 0),
    history_exhausted: source.history_exhausted === true,
    exhausted_at: normalizeIsoUtc(source.exhausted_at),
    retry_count: parseNonNegativeInt(source.retry_count, 0),
    last_error_code: normalizeText(source.last_error_code) || null,
    last_error_at: normalizeIsoUtc(source.last_error_at),
    stop_reason: normalizeText(source.stop_reason) || null,
    updated_at: normalizeIsoUtc(source.updated_at)
  };
}

function normalizeScope(scope = {}) {
  const companyId = normalizeText(scope.companyId);
  const agentId = normalizeText(scope.agentId);
  const deviceUid = normalizeText(scope.deviceUid);
  if (!companyId || !agentId || !deviceUid) {
    throw new Error('invalid_scope');
  }
  return { companyId, agentId, deviceUid };
}

function normalizeDirection(value) {
  const direction = normalizeText(value).toUpperCase();
  return direction === 'IN' || direction === 'OUT' ? direction : null;
}

function normalizeConfidence(value) {
  return normalizeText(value).toLowerCase() || null;
}

function confidenceLooksHigh(value) {
  const confidence = normalizeConfidence(value);
  return confidence === 'provisional_high' || confidence === 'high';
}

function buildSubjectKey(event = {}) {
  const personId = normalizeText(event.person_id);
  if (personId) {
    return `person:${personId}`;
  }
  const devicePersonId = normalizeText(event.device_person_id);
  if (devicePersonId) {
    return `device_person:${devicePersonId}`;
  }
  return 'subject:unknown';
}

function diffMs(leftIso, rightIso) {
  const left = new Date(leftIso).getTime();
  const right = new Date(rightIso).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(left - right);
}

function findClosestRtCandidate(eventRow, rtRows, options = {}) {
  const observedToleranceMs = Number.isInteger(options.observedToleranceMs) && options.observedToleranceMs > 0
    ? options.observedToleranceMs
    : 2000;
  const createdAtToleranceMs = Number.isInteger(options.createdAtToleranceMs) && options.createdAtToleranceMs > 0
    ? options.createdAtToleranceMs
    : 5000;
  const eventTime = normalizeIsoUtc(eventRow.event_time_utc);
  if (!eventTime) {
    return null;
  }
  const eventSubjectKey = buildSubjectKey(eventRow);
  let best = null;
  for (const rtRow of rtRows) {
    const rtSubjectKey = buildSubjectKey(rtRow);
    if (eventSubjectKey !== rtSubjectKey) {
      continue;
    }
    const timeContract = parseRtTimeContract(rtRow.source_metadata);
    const observedClockTrusted = !(timeContract.version === 'dual_time_v1'
      && timeContract.observed_trust === 'untrusted');
    const candidates = [
      {
        clock: 'observed_at_utc',
        rt_time_utc: normalizeIsoUtc(rtRow.observed_at_utc),
        tolerance_ms: observedToleranceMs,
        rank: 1,
        enabled: observedClockTrusted
      },
      {
        clock: 'created_at_provisional',
        rt_time_utc: normalizeIsoUtc(rtRow.created_at),
        tolerance_ms: createdAtToleranceMs,
        rank: 2,
        enabled: true
      }
    ];
    for (const candidate of candidates) {
      if (candidate.enabled !== true) {
        continue;
      }
      if (!candidate.rt_time_utc) {
        continue;
      }
      const deltaMs = diffMs(eventTime, candidate.rt_time_utc);
      if (deltaMs > candidate.tolerance_ms) {
        continue;
      }
      const shouldReplace = !best
        || candidate.rank < best.rank
        || (candidate.rank === best.rank && deltaMs < best.delta_ms);
      if (shouldReplace) {
        best = {
          row: rtRow,
          delta_ms: deltaMs,
          match_clock: candidate.clock,
          matched_rt_time_utc: candidate.rt_time_utc,
          tolerance_ms: candidate.tolerance_ms,
          rank: candidate.rank
        };
      }
    }
  }
  return best;
}

function deriveArtifact(eventRow, rtMatch, context = {}) {
  const pullDirection = normalizeDirection(eventRow.direction);
  const base = {
    subject_key: buildSubjectKey(eventRow),
    fact_anchor_utc: normalizeIsoUtc(eventRow.event_time_utc),
    device_person_id: normalizeText(eventRow.device_person_id) || null,
    person_id: normalizeText(eventRow.person_id) || null,
    derived_direction: null,
    artifact_outcome: OUTCOME.UNRESOLVED,
    confidence: 'none',
    confidence_basis: 'insufficient_evidence',
    conflict_flag: false,
    source_hierarchy: 'rt_first_then_pull_fallback',
    source_refs: {
      fact_event_id: eventRow.id,
      rt_observation_id: null
    },
    source_metadata: {
      derivation_version: DERIVATION_VERSION,
      derivation_run_id: context.derivationRunId,
      lane_session_id: context.laneSessionId,
      rt_match_delta_ms: null
    }
  };

  if (rtMatch && rtMatch.row) {
    const rtDirection = normalizeDirection(rtMatch.row.direction_provisional);
    const rtConfidence = normalizeConfidence(rtMatch.row.confidence) || 'provisional_low';
    base.source_refs.rt_observation_id = rtMatch.row.id;
    base.source_metadata.rt_match_delta_ms = rtMatch.delta_ms;
    base.source_metadata.rt_match_clock = normalizeText(rtMatch.match_clock) || 'unknown';
    base.source_metadata.rt_match_tolerance_ms = Number.isInteger(rtMatch.tolerance_ms)
      ? rtMatch.tolerance_ms
      : null;
    base.source_metadata.rt_matched_time_utc = normalizeIsoUtc(rtMatch.matched_rt_time_utc);
    base.source_metadata.rt_observed_at_utc = normalizeIsoUtc(rtMatch.row.observed_at_utc);
    base.source_metadata.rt_created_at_utc = normalizeIsoUtc(rtMatch.row.created_at);
    base.source_metadata.rt_state_code = normalizeText(rtMatch.row.rt_state_code) || null;
    base.source_metadata.rt_source = normalizeText(rtMatch.row.source) || null;

    if (rtDirection) {
      base.derived_direction = rtDirection;
      base.confidence = rtConfidence;
      const matchedOnCreatedAt = normalizeText(rtMatch.match_clock) === 'created_at_provisional';
      if (pullDirection && pullDirection !== rtDirection) {
        base.conflict_flag = true;
        base.artifact_outcome = OUTCOME.INFORMATIONAL_ONLY;
        base.confidence_basis = matchedOnCreatedAt
          ? 'rt_pull_conflict_created_at_provisional'
          : 'rt_pull_conflict';
      } else if (confidenceLooksHigh(rtConfidence)) {
        base.artifact_outcome = OUTCOME.USABLE;
        base.confidence_basis = matchedOnCreatedAt
          ? 'rt_correlated_high_created_at_provisional'
          : 'rt_correlated_high';
      } else {
        base.artifact_outcome = OUTCOME.INFORMATIONAL_ONLY;
        base.confidence_basis = matchedOnCreatedAt
          ? 'rt_correlated_low_created_at_provisional'
          : 'rt_correlated_low';
      }
      return base;
    }
  }

  if (pullDirection) {
    base.derived_direction = pullDirection;
    base.artifact_outcome = OUTCOME.INFORMATIONAL_ONLY;
    base.confidence = 'fallback_low';
    base.confidence_basis = 'pull_status_map_fallback';
    return base;
  }

  return base;
}

function fingerprintArtifact(artifact) {
  const payload = {
    subject_key: artifact.subject_key,
    fact_anchor_utc: artifact.fact_anchor_utc,
    derived_direction: artifact.derived_direction,
    artifact_outcome: artifact.artifact_outcome,
    confidence: artifact.confidence,
    confidence_basis: artifact.confidence_basis,
    source_refs: artifact.source_refs
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function buildAttachmentSourceRefs(eventRow, artifact, options = {}) {
  const pullMeta = parseMetadata(eventRow && eventRow.source_metadata);
  const refs = {
    fact_event_id: eventRow.id,
    rt_observation_id: artifact && artifact.source_refs ? artifact.source_refs.rt_observation_id || null : null,
    historical_artifact_id: normalizeText(options.historicalArtifactId) || null
  };
  if (pullMeta && Object.keys(pullMeta).length > 0) {
    refs.pull_direction_contract_version = normalizeText(pullMeta.direction_contract_version) || null;
    refs.pull_direction_basis = normalizeText(pullMeta.direction_basis) || null;
    refs.pull_direction_basis_field = normalizeText(pullMeta.direction_basis_field) || null;
    if (Object.prototype.hasOwnProperty.call(pullMeta, 'direction_basis_value')) {
      refs.pull_direction_basis_value = pullMeta.direction_basis_value;
    } else {
      refs.pull_direction_basis_value = null;
    }
    refs.pull_direction_flattened_value = normalizeText(pullMeta.direction_flattened_value) || null;
    refs.pull_direction_authority = normalizeText(pullMeta.direction_authority) || null;
    refs.pull_direction_confidence = normalizeText(pullMeta.direction_confidence) || null;
  }
  return refs;
}

function buildAttachmentSourceMetadata(artifact, context = {}) {
  const sourceMetadata = isPlainObject(artifact && artifact.source_metadata)
    ? { ...artifact.source_metadata }
    : {};
  const resolvedStrategy = isPlainObject(context.directionAuthorityStrategyResolved)
    ? context.directionAuthorityStrategyResolved
    : null;
  const effectiveStrategy = isPlainObject(context.directionAuthorityStrategyEffective)
    ? context.directionAuthorityStrategyEffective
    : null;
  sourceMetadata.attachment_contract_version = 'derived_direction_attachment_v1';
  sourceMetadata.derived_from = 'historical_direction_derivation';
  sourceMetadata.derivation_version = normalizeText(context.derivationVersion) || DERIVATION_VERSION;
  sourceMetadata.derivation_run_id = normalizeText(context.derivationRunId) || null;
  sourceMetadata.lane_session_id = normalizeText(context.laneSessionId) || null;
  if (resolvedStrategy) {
    sourceMetadata.direction_authority_strategy_resolved = {
      strategy_id: normalizeText(resolvedStrategy.resolved_strategy_id) || null,
      resolution_source: normalizeText(resolvedStrategy.resolution_source) || null,
      resolution_vendor: normalizeText(resolvedStrategy.resolution_vendor) || null,
      resolution_model: normalizeText(resolvedStrategy.resolution_model) || null,
      contract_version: normalizeText(resolvedStrategy.contract_version) || null
    };
  }
  if (effectiveStrategy) {
    sourceMetadata.direction_authority_strategy_effective = {
      strategy_id: normalizeText(effectiveStrategy.effective_strategy_id) || null,
      behavior_mode: normalizeText(effectiveStrategy.behavior_mode) || null,
      behavior_change_applied: effectiveStrategy.behavior_change_applied === true,
      resolved_strategy_id: normalizeText(effectiveStrategy.resolved_strategy_id) || null
    };
  }
  return sourceMetadata;
}

async function readDeviceDirectionProfileContext(db, scope) {
  try {
    const res = await db.query(
      `
      SELECT provider, metadata
      FROM devices
      WHERE company_id = $1
        AND device_uid = $2
      LIMIT 1
      `,
      [scope.companyId, scope.deviceUid]
    );
    const row = res.rows[0] || {};
    const metadata = parseMetadata(row.metadata);
    const deviceProfile = parseMetadata(metadata.device_profile);
    const resolved = resolveDirectionAuthorityStrategy({
      device_uid: scope.deviceUid,
      vendor: normalizeText(row.provider) || null,
      model: normalizeText(deviceProfile.model) || null,
      device_profile: deviceProfile
    });
    const effective = resolveEffectiveDirectionAuthorityStrategyBehavior(resolved);
    return {
      vendor: normalizeText(row.provider) || null,
      device_profile: deviceProfile,
      resolved,
      effective
    };
  } catch (err) {
    const resolved = resolveDirectionAuthorityStrategy({
      device_uid: scope.deviceUid,
      vendor: null,
      model: null,
      device_profile: {}
    });
    const effective = resolveEffectiveDirectionAuthorityStrategyBehavior(resolved);
    return {
      vendor: null,
      device_profile: {},
      resolved,
      effective
    };
  }
}

async function upsertDerivedDirectionAttachment(db, scope, eventRow, artifact, context = {}) {
  if (!artifact || !artifact.fact_anchor_utc || !eventRow || !eventRow.id) {
    return null;
  }
  const sourceRefs = buildAttachmentSourceRefs(eventRow, artifact, {
    historicalArtifactId: context.historicalArtifactId || null
  });
  const sourceMetadata = buildAttachmentSourceMetadata(artifact, context);
  const res = await db.query(
    `
    INSERT INTO derived_direction_attachments (
      company_id,
      agent_id,
      device_uid,
      fact_event_id,
      fact_anchor_utc,
      subject_key,
      derived_direction,
      artifact_outcome,
      confidence,
      confidence_basis,
      conflict_flag,
      source_refs,
      source_metadata,
      derivation_version,
      derivation_run_id,
      lane_session_id
    )
    VALUES (
      $1, $2::uuid, $3, $4::uuid, $5::timestamptz, $6, $7, $8, $9, $10, $11::boolean,
      $12::jsonb, $13::jsonb, $14, $15, $16
    )
    ON CONFLICT (company_id, fact_event_id)
    DO UPDATE SET
      agent_id = EXCLUDED.agent_id,
      device_uid = EXCLUDED.device_uid,
      fact_anchor_utc = EXCLUDED.fact_anchor_utc,
      subject_key = EXCLUDED.subject_key,
      derived_direction = EXCLUDED.derived_direction,
      artifact_outcome = EXCLUDED.artifact_outcome,
      confidence = EXCLUDED.confidence,
      confidence_basis = EXCLUDED.confidence_basis,
      conflict_flag = EXCLUDED.conflict_flag,
      source_refs = EXCLUDED.source_refs,
      source_metadata = EXCLUDED.source_metadata,
      derivation_version = EXCLUDED.derivation_version,
      derivation_run_id = EXCLUDED.derivation_run_id,
      lane_session_id = EXCLUDED.lane_session_id,
      updated_at = now()
    RETURNING id
    `,
    [
      scope.companyId,
      scope.agentId,
      scope.deviceUid,
      eventRow.id,
      artifact.fact_anchor_utc,
      artifact.subject_key,
      artifact.derived_direction,
      artifact.artifact_outcome,
      artifact.confidence,
      artifact.confidence_basis,
      artifact.conflict_flag === true,
      JSON.stringify(sourceRefs),
      JSON.stringify(sourceMetadata),
      normalizeText(context.derivationVersion) || DERIVATION_VERSION,
      normalizeText(context.derivationRunId) || `attachment-${new Date().toISOString()}`,
      normalizeText(context.laneSessionId) || null
    ]
  );
  return res.rows[0] ? res.rows[0].id : null;
}

async function deriveAndUpsertDirectionAttachmentForFactEvent(db, scopeInput, options = {}) {
  const scope = normalizeScope(scopeInput);
  const factEventId = normalizeText(options.factEventId);
  if (!factEventId) {
    throw new Error('fact_event_id_required');
  }
  const derivationRunId = normalizeText(options.derivationRunId)
    || `derived-attachment-${new Date().toISOString()}`;
  const laneSessionId = normalizeText(options.laneSessionId) || null;
  const observedToleranceMs = Number.isInteger(options.observedToleranceMs) && options.observedToleranceMs > 0
    ? Math.min(options.observedToleranceMs, 60000)
    : 2000;
  const createdAtToleranceMs = Number.isInteger(options.createdAtToleranceMs) && options.createdAtToleranceMs > 0
    ? Math.min(options.createdAtToleranceMs, 60000)
    : 5000;
  const maxToleranceMs = Math.max(observedToleranceMs, createdAtToleranceMs);
  const lookaroundMs = Number.isInteger(options.lookaroundMs) && options.lookaroundMs > 0
    ? Math.min(options.lookaroundMs, 300000)
    : 60000;
  const scanWindowMs = Math.max(lookaroundMs, maxToleranceMs + 1000);

  await db.query('BEGIN');
  try {
    const deviceProfileContext = await readDeviceDirectionProfileContext(db, scope);
    const eventRes = await db.query(
      `
      SELECT
        id,
        event_time_utc,
        event_time_local,
        device_person_id,
        person_id,
        direction,
        dedup_key,
        source_metadata,
        vendor
      FROM device_events
      WHERE company_id = $1
        AND device_uid = $2
        AND id = $3::uuid
      LIMIT 1
      FOR UPDATE
      `,
      [scope.companyId, scope.deviceUid, factEventId]
    );
    const eventRow = eventRes.rows[0] || null;
    if (!eventRow) {
      throw new Error('fact_event_not_found');
    }
    const factAnchorUtc = normalizeIsoUtc(eventRow.event_time_utc);
    if (!factAnchorUtc) {
      throw new Error('fact_event_time_invalid');
    }
    const factMs = new Date(factAnchorUtc).getTime();
    const windowStart = new Date(factMs - scanWindowMs).toISOString();
    const windowEnd = new Date(factMs + scanWindowMs).toISOString();

    const rtRes = await db.query(
      `
      SELECT
        id,
        observed_at_utc,
        created_at,
        device_person_id,
        person_id,
        rt_state_code,
        direction_provisional,
        confidence,
        source,
        source_metadata
      FROM device_realtime_direction_observations
      WHERE company_id = $1
        AND device_uid = $2
        AND (
          (observed_at_utc >= $3::timestamptz AND observed_at_utc <= $4::timestamptz)
          OR
          (created_at >= $3::timestamptz AND created_at <= $4::timestamptz)
        )
      ORDER BY observed_at_utc ASC, id ASC
      `,
      [scope.companyId, scope.deviceUid, windowStart, windowEnd]
    );
    const rtRows = rtRes.rows || [];
    const rtMatch = findClosestRtCandidate(eventRow, rtRows, {
      observedToleranceMs,
      createdAtToleranceMs
    });
    const artifact = deriveArtifact(eventRow, rtMatch, {
      derivationRunId,
      laneSessionId
    });
    const attachmentId = await upsertDerivedDirectionAttachment(db, scope, eventRow, artifact, {
      derivationVersion: DERIVATION_VERSION,
      derivationRunId,
      laneSessionId,
      directionAuthorityStrategyResolved: deviceProfileContext.resolved,
      directionAuthorityStrategyEffective: deviceProfileContext.effective
    });
    await db.query('COMMIT');
    return {
      attachment_id: attachmentId,
      derivation_run_id: derivationRunId,
      fact_event_id: eventRow.id,
      rt_observation_id: artifact && artifact.source_refs ? artifact.source_refs.rt_observation_id || null : null,
      derived_direction: artifact.derived_direction,
      artifact_outcome: artifact.artifact_outcome,
      confidence: artifact.confidence,
      confidence_basis: artifact.confidence_basis,
      conflict_flag: artifact.conflict_flag === true
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function processHistoricalDirectionWindow(db, scopeInput, options = {}) {
  const scope = normalizeScope(scopeInput);
  const windowLimit = Number.isInteger(options.windowLimit) && options.windowLimit > 0
    ? Math.min(options.windowLimit, 500)
    : 100;
  const correlationToleranceMs = Number.isInteger(options.correlationToleranceMs) && options.correlationToleranceMs > 0
    ? Math.min(options.correlationToleranceMs, 60000)
    : 2000;
  const createdAtCorrelationToleranceMs =
    Number.isInteger(options.createdAtCorrelationToleranceMs) && options.createdAtCorrelationToleranceMs > 0
      ? Math.min(options.createdAtCorrelationToleranceMs, 60000)
      : 5000;
  const derivationRunId = normalizeText(options.derivationRunId)
    || `hist-derivation-${new Date().toISOString()}`;

  await db.query('BEGIN');
  try {
    const deviceProfileContext = await readDeviceDirectionProfileContext(db, scope);
    const syncRes = await db.query(
      `
      SELECT metadata
      FROM agent_device_sync_states
      WHERE company_id = $1
        AND agent_id = $2::uuid
        AND device_uid = $3
      LIMIT 1
      FOR UPDATE
      `,
      [scope.companyId, scope.agentId, scope.deviceUid]
    );
    if (syncRes.rows.length === 0) {
      throw new Error('sync_state_not_found');
    }

    const metadata = parseMetadata(syncRes.rows[0].metadata);
    const laneState = parseLaneState(metadata.direction_historical);
    const laneSessionId = normalizeText(laneState.session_id) || normalizeText(options.sessionId);
    if (!laneSessionId) {
      throw new Error('lane_session_missing');
    }

    const windowBeforeUtcExclusive = laneState.window_before_utc_exclusive || new Date().toISOString();
    const eventRes = await db.query(
      `
      SELECT
        id,
        event_time_utc,
        event_time_local,
        device_person_id,
        person_id,
        direction,
        dedup_key,
        source_metadata,
        vendor
      FROM device_events
      WHERE company_id = $1
        AND device_uid = $2
        AND event_time_utc < $3::timestamptz
      ORDER BY event_time_utc DESC, id DESC
      LIMIT $4
      `,
      [scope.companyId, scope.deviceUid, windowBeforeUtcExclusive, windowLimit]
    );
    const eventRows = eventRes.rows || [];

    if (eventRows.length === 0) {
      const noProgressWindows = parseNonNegativeInt(laneState.no_progress_windows, 0) + 1;
      const nowIso = new Date().toISOString();
      const updatedLaneState = {
        ...laneState,
        status: DIRECTION_HISTORICAL_STATUS.STOPPED,
        no_progress_windows: noProgressWindows,
        history_exhausted: true,
        exhausted_at: nowIso,
        stop_reason: DIRECTION_HISTORICAL_STOP_REASON.HISTORY_EXHAUSTED,
        last_artifact_count: 0,
        updated_at: nowIso
      };
      await db.query(
        `
        UPDATE agent_device_sync_states
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
            updated_at = now()
        WHERE company_id = $1
          AND agent_id = $2::uuid
          AND device_uid = $3
        `,
        [
          scope.companyId,
          scope.agentId,
          scope.deviceUid,
          JSON.stringify({ direction_historical: updatedLaneState })
        ]
      );
      await db.query('COMMIT');
      return {
        derivation_run_id: derivationRunId,
        lane_session_id: laneSessionId,
        window_processed: 0,
        artifacts_written: 0,
        counts: {
          usable: 0,
          informational_only: 0,
          unresolved: 0
        },
        checkpoint_advanced: false,
        history_exhausted: true,
        stop_reason: DIRECTION_HISTORICAL_STOP_REASON.HISTORY_EXHAUSTED
      };
    }

    const oldest = eventRows[eventRows.length - 1];
    const newest = eventRows[0];
    const oldestUtc = normalizeIsoUtc(oldest.event_time_utc);
    const newestUtc = normalizeIsoUtc(newest.event_time_utc);
    const nextWindowBeforeUtc = oldestUtc;
    const nextWindowBeforeAnchorKey = normalizeText(oldest.dedup_key) || String(oldest.id);

    const rtRes = await db.query(
      `
      SELECT
        id,
        observed_at_utc,
        created_at,
        device_person_id,
        person_id,
        rt_state_code,
        direction_provisional,
        confidence,
        source,
        source_metadata
      FROM device_realtime_direction_observations
      WHERE company_id = $1
        AND device_uid = $2
        AND (
          (observed_at_utc >= $3::timestamptz AND observed_at_utc < $4::timestamptz)
          OR
          (created_at >= $3::timestamptz AND created_at < $4::timestamptz)
        )
      ORDER BY observed_at_utc ASC, id ASC
      `,
      [scope.companyId, scope.deviceUid, oldestUtc, windowBeforeUtcExclusive]
    );
    const rtRows = rtRes.rows || [];

    const counts = {
      usable: 0,
      informational_only: 0,
      unresolved: 0
    };
    let artifactsWritten = 0;
    const fingerprints = [];

    for (const eventRow of eventRows) {
      const rtMatch = findClosestRtCandidate(eventRow, rtRows, {
        observedToleranceMs: correlationToleranceMs,
        createdAtToleranceMs: createdAtCorrelationToleranceMs
      });
      const artifact = deriveArtifact(eventRow, rtMatch, {
        derivationRunId,
        laneSessionId
      });
      if (!artifact.fact_anchor_utc) {
        continue;
      }
      const artifactFingerprint = fingerprintArtifact(artifact);
      fingerprints.push(artifactFingerprint);
      const insertRes = await db.query(
        `
        INSERT INTO historical_direction_artifacts (
          company_id,
          agent_id,
          device_uid,
          derivation_run_id,
          derivation_version,
          lane_session_id,
          lane_window_before_utc_exclusive,
          lane_window_before_anchor_key,
          fact_event_id,
          fact_anchor_utc,
          device_person_id,
          person_id,
          subject_key,
          derived_direction,
          artifact_outcome,
          confidence,
          confidence_basis,
          conflict_flag,
          source_hierarchy,
          source_refs,
          source_metadata,
          artifact_fingerprint
        )
        VALUES (
          $1, $2::uuid, $3, $4, $5, $6, $7::timestamptz, $8, $9::uuid, $10::timestamptz,
          $11, $12, $13, $14, $15, $16, $17, $18::boolean, $19, $20::jsonb, $21::jsonb, $22
        )
        ON CONFLICT DO NOTHING
        RETURNING id
        `,
        [
          scope.companyId,
          scope.agentId,
          scope.deviceUid,
          derivationRunId,
          DERIVATION_VERSION,
          laneSessionId,
          windowBeforeUtcExclusive,
          laneState.window_before_anchor_key || null,
          eventRow.id,
          artifact.fact_anchor_utc,
          artifact.device_person_id,
          artifact.person_id,
          artifact.subject_key,
          artifact.derived_direction,
          artifact.artifact_outcome,
          artifact.confidence,
          artifact.confidence_basis,
          artifact.conflict_flag === true,
          artifact.source_hierarchy,
          JSON.stringify(artifact.source_refs || {}),
          JSON.stringify(artifact.source_metadata || {}),
          artifactFingerprint
        ]
      );
      let historicalArtifactId = insertRes.rows[0] ? insertRes.rows[0].id : null;
      if (!historicalArtifactId) {
        const existingRes = await db.query(
          `
          SELECT id
          FROM historical_direction_artifacts
          WHERE company_id = $1
            AND device_uid = $2
            AND fact_event_id = $3::uuid
            AND derivation_version = $4
            AND artifact_fingerprint = $5
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [
            scope.companyId,
            scope.deviceUid,
            eventRow.id,
            DERIVATION_VERSION,
            artifactFingerprint
          ]
        );
        historicalArtifactId = existingRes.rows[0] ? existingRes.rows[0].id : null;
      }
      await upsertDerivedDirectionAttachment(db, scope, eventRow, artifact, {
        derivationVersion: DERIVATION_VERSION,
        derivationRunId,
        laneSessionId,
        historicalArtifactId,
        directionAuthorityStrategyResolved: deviceProfileContext.resolved,
        directionAuthorityStrategyEffective: deviceProfileContext.effective
      });
      if (insertRes.rowCount === 1) {
        artifactsWritten += 1;
      }
      counts[artifact.artifact_outcome] += 1;
    }

    const lastArtifactFingerprint = crypto
      .createHash('sha256')
      .update(fingerprints.sort().join('\n'))
      .digest('hex');
    const nowIso = new Date().toISOString();
    const updatedLaneState = {
      ...laneState,
      status: DIRECTION_HISTORICAL_STATUS.RUNNING,
      session_id: laneSessionId,
      window_before_utc_exclusive: nextWindowBeforeUtc,
      window_before_anchor_key: nextWindowBeforeAnchorKey,
      last_processed_utc: oldestUtc,
      last_artifact_fingerprint: lastArtifactFingerprint,
      last_artifact_count: artifactsWritten,
      no_progress_windows: 0,
      history_exhausted: false,
      exhausted_at: null,
      stop_reason: null,
      updated_at: nowIso
    };

    await db.query(
      `
      UPDATE agent_device_sync_states
      SET metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
          updated_at = now()
      WHERE company_id = $1
        AND agent_id = $2::uuid
        AND device_uid = $3
      `,
      [
        scope.companyId,
        scope.agentId,
        scope.deviceUid,
        JSON.stringify({ direction_historical: updatedLaneState })
      ]
    );

    await db.query('COMMIT');
    return {
      derivation_run_id: derivationRunId,
      lane_session_id: laneSessionId,
      window_processed: eventRows.length,
      window_bounds: {
        newest_utc: newestUtc,
        oldest_utc: oldestUtc,
        previous_window_before_utc_exclusive: windowBeforeUtcExclusive,
        next_window_before_utc_exclusive: nextWindowBeforeUtc
      },
      artifacts_written: artifactsWritten,
      counts,
      checkpoint_advanced: true,
      history_exhausted: false,
      stop_reason: null
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  DERIVATION_VERSION,
  OUTCOME,
  processHistoricalDirectionWindow,
  deriveAndUpsertDirectionAttachmentForFactEvent
};
