function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parseLimit(value, fallback = 50, max = 200) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function parseIso(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return { value: null };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { error: 'invalid_iso_datetime' };
  }
  return { value: parsed.toISOString() };
}

function selectedSourceMetadata(metadata) {
  const source = isPlainObject(metadata) ? metadata : {};
  return {
    rt_time_contract_version: source.rt_time_contract_version || null,
    rt_time_observed_basis: source.rt_time_observed_basis || null,
    rt_time_observed_trust: source.rt_time_observed_trust || null,
    rt_time_decoded_basis: source.rt_time_decoded_basis || null,
    rt_time_decoded_local: source.rt_time_decoded_local || null,
    rt_time_decoded_utc: source.rt_time_decoded_utc || null,
    rt_time_chronology_utc: source.rt_time_chronology_utc || null,
    rt_time_chronology_source: source.rt_time_chronology_source || null,
    rt_time_wall_clock_event_trust: source.rt_time_wall_clock_event_trust || null,
    k80_rt_basis: source.k80_rt_basis || null,
    k80_rt_correlation_source: source.k80_rt_correlation_source || null,
    k80_rt_correlation_confidence: source.k80_rt_correlation_confidence || null,
    mapped_person_id: source.mapped_person_id || null,
    mapping_applied: source.mapping_applied === true,
    mapping_reason: source.mapping_reason || null
  };
}

function toObservationRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    company_id: row.company_id,
    agent_id: row.agent_id,
    device_uid: row.device_uid,
    batch_id: row.batch_id,
    command_id: row.command_id,
    vendor: row.vendor,
    observed_at_utc: row.observed_at_utc,
    observed_at_local: row.observed_at_local,
    device_timezone: row.device_timezone,
    device_person_id: row.device_person_id,
    person_id: row.person_id,
    rt_state_code: row.rt_state_code,
    rt_state_label_provisional: row.rt_state_label_provisional,
    direction_provisional: row.direction_provisional,
    confidence: row.confidence,
    source: row.source,
    source_metadata: selectedSourceMetadata(row.source_metadata),
    created_at: row.created_at
  };
}

async function listRealtimeObservations(db, {
  companyId,
  deviceUid,
  agentId,
  afterCreatedAt,
  afterId,
  observedFrom,
  observedTo,
  limit,
  ascending = true
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeDeviceUid = normalizeText(deviceUid);
  if (!safeCompanyId || !safeDeviceUid) {
    return { error: 'invalid_request' };
  }
  const createdCursor = parseIso(afterCreatedAt);
  if (createdCursor.error) {
    return { error: 'after_created_at_invalid' };
  }
  const observedFromParsed = parseIso(observedFrom);
  if (observedFromParsed.error) {
    return { error: 'observed_from_invalid' };
  }
  const observedToParsed = parseIso(observedTo);
  if (observedToParsed.error) {
    return { error: 'observed_to_invalid' };
  }

  const params = [safeCompanyId, safeDeviceUid];
  const where = ['company_id = $1', 'device_uid = $2'];
  const safeAgentId = normalizeText(agentId);
  if (safeAgentId) {
    params.push(safeAgentId);
    where.push(`agent_id = $${params.length}::uuid`);
  }
  const safeAfterId = normalizeText(afterId);
  if (createdCursor.value && safeAfterId) {
    params.push(createdCursor.value, safeAfterId);
    where.push(`(created_at, id::text) > ($${params.length - 1}::timestamptz, $${params.length})`);
  } else if (createdCursor.value) {
    params.push(createdCursor.value);
    where.push(`created_at > $${params.length}::timestamptz`);
  }
  if (observedFromParsed.value) {
    params.push(observedFromParsed.value);
    where.push(`observed_at_utc >= $${params.length}::timestamptz`);
  }
  if (observedToParsed.value) {
    params.push(observedToParsed.value);
    where.push(`observed_at_utc <= $${params.length}::timestamptz`);
  }
  params.push(parseLimit(limit));

  const direction = ascending ? 'ASC' : 'DESC';
  const res = await db.query(
    `
    SELECT id, company_id, agent_id, device_uid, batch_id, command_id, vendor,
           observed_at_utc, observed_at_local, device_timezone, device_person_id,
           person_id, rt_state_code, rt_state_label_provisional, direction_provisional,
           confidence, source, source_metadata, created_at
    FROM device_realtime_direction_observations
    WHERE ${where.join(' AND ')}
    ORDER BY created_at ${direction}, id ${direction}
    LIMIT $${params.length}
    `,
    params
  );

  return {
    value: res.rows.map(toObservationRow),
    count: res.rows.length
  };
}

module.exports = {
  listRealtimeObservations,
  __test: {
    selectedSourceMetadata,
    toObservationRow
  }
};
