const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const service = require('../../services/agentDeviceEventsService');

function createQueueDbMock(captures, options = {}) {
  const canonicalDeviceUid = options.canonicalDeviceUid || 'zkteco:sn:ABC001';
  const directLookupHit = options.directLookupHit !== false;
  const aliasRow = options.aliasRow || null;
  const directLookupRow = options.directLookupRow || null;
  const activeBindingRow = Object.prototype.hasOwnProperty.call(options, 'activeBindingRow')
    ? options.activeBindingRow
    : {
      id: 'binding-1',
      company_id: 'DEFAULT',
      device_uid: canonicalDeviceUid,
      agent_id: 'agent-1',
      status: 'active',
      bound_at: '2026-03-18T00:00:00.000Z',
      updated_at: '2026-03-18T00:00:00.000Z'
    };
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM agent_commands') && text.includes("status = $3") && text.includes("status = 'queued'") === false) {
        return { rows: [] };
      }
      if (text.includes('SELECT id, company_id, agent_name, status') && text.includes('FROM agent_nodes')) {
        return {
          rows: [{
            id: 'agent-1',
            company_id: 'DEFAULT',
            agent_name: 'a1',
            status: 'active'
          }]
        };
      }
      if (text.includes('SELECT device_uid') && text.includes('FROM devices') && text.includes('device_uid = $2')) {
        captures.canonicalLookupInput = params[1];
        if (directLookupRow) {
          return { rows: [directLookupRow] };
        }
        if (directLookupHit) {
          return {
            rows: [{
              device_uid: canonicalDeviceUid,
              identity_status: 'canonical',
              superseded_by_device_uid: null
            }]
          };
        }
        return { rows: [] };
      }
      if (text.includes('FROM device_identity_aliases')) {
        captures.aliasLookupInput = params[1];
        if (!aliasRow) {
          return { rows: [] };
        }
        return {
          rows: [{
            canonical_device_uid: aliasRow.canonical_device_uid || canonicalDeviceUid,
            alias_kind: aliasRow.alias_kind || 'device_uid',
            status: aliasRow.status || 'active'
          }]
        };
      }
      if (text.includes('SELECT')
        && text.includes('FROM devices')
        && text.includes('managed_status')
        && text.includes('discovery_metadata')) {
        captures.managedLookupUid = params[1];
        return {
          rows: [{
            company_id: 'DEFAULT',
            device_uid: canonicalDeviceUid,
            provider: 'zkteco',
            managed_status: 'managed',
            active: true,
            metadata: {
              auth_password: 4321
            },
            discovery_metadata: {
              ip: '192.168.1.20',
              protocol: {
                port: 4370
              }
            }
          }]
        };
      }
      if (text.includes('INSERT INTO agent_device_sync_states')) {
        captures.syncStateDeviceUid = params[2];
        return {
          rows: [{
            cursor_event_time_utc: '2026-03-06T10:00:00.000Z'
          }]
        };
      }
      if (text.includes('FROM agent_commands') && text.includes("status IN ('queued', 'sent')")) {
        captures.inFlightDeviceUid = params[3];
        return {
          rows: captures.inFlightRow ? [captures.inFlightRow] : []
        };
      }
      if (text.includes('FROM device_managing_agent_bindings') && text.includes("status = 'active'")) {
        captures.bindingLookupDeviceUid = params[1];
        if (!activeBindingRow) {
          return { rows: [] };
        }
        return { rows: [activeBindingRow] };
      }
      if (text.includes('SELECT company_timezone') && text.includes('FROM company_config')) {
        return {
          rows: [{ company_timezone: 'Africa/Tunis' }]
        };
      }
      if (text.includes('INSERT INTO agent_commands')) {
        captures.commandPayload = JSON.parse(params[3]);
        captures.commandDeviceUid = captures.commandPayload.device_uid;
        captures.commandTtlSeconds = params[5];
        return {
          rows: [{
            id: 'cmd-1',
            company_id: 'DEFAULT',
            agent_id: 'agent-1',
            command_type: 'PULL_DEVICE_EVENTS',
            command_payload: captures.commandPayload,
            status: 'queued',
            created_at: '2026-03-06T10:00:00.000Z',
            expires_at: '2026-03-06T10:30:00.000Z'
          }]
        };
      }
      if (text.includes('UPDATE agent_device_sync_states') && text.includes('metadata = metadata || $1::jsonb')) {
        captures.syncUpdateMetadata = JSON.parse(params[0]);
        captures.syncUpdateDeviceUid = params[3];
        captures.syncUpdateQuery = text;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query in queue test: ${text.slice(0, 120)}`);
    }
  };
}

async function withIdentityMappingsRequired(fn) {
  const prior = {
    USE_IDENTITY_MAPPINGS: process.env.USE_IDENTITY_MAPPINGS,
    REQUIRE_IDENTITY_MAPPINGS: process.env.REQUIRE_IDENTITY_MAPPINGS,
    IDENTITY_MAPPING_POLICY: process.env.IDENTITY_MAPPING_POLICY
  };
  process.env.USE_IDENTITY_MAPPINGS = '1';
  process.env.REQUIRE_IDENTITY_MAPPINGS = '1';
  process.env.IDENTITY_MAPPING_POLICY = 'all';
  try {
    return await fn();
  } finally {
    if (typeof prior.USE_IDENTITY_MAPPINGS === 'undefined') {
      delete process.env.USE_IDENTITY_MAPPINGS;
    } else {
      process.env.USE_IDENTITY_MAPPINGS = prior.USE_IDENTITY_MAPPINGS;
    }
    if (typeof prior.REQUIRE_IDENTITY_MAPPINGS === 'undefined') {
      delete process.env.REQUIRE_IDENTITY_MAPPINGS;
    } else {
      process.env.REQUIRE_IDENTITY_MAPPINGS = prior.REQUIRE_IDENTITY_MAPPINGS;
    }
    if (typeof prior.IDENTITY_MAPPING_POLICY === 'undefined') {
      delete process.env.IDENTITY_MAPPING_POLICY;
    } else {
      process.env.IDENTITY_MAPPING_POLICY = prior.IDENTITY_MAPPING_POLICY;
    }
  }
}

function createIngestDbMock(captures, options = {}) {
  const identityLookup = options.identityLookup || {};
  const insertRowCountByIdentifier = options.insertRowCountByIdentifier || {};
  const canonicalDeviceUid = options.canonicalDeviceUid || 'zkteco:sn:ABC001';
  const directLookupHit = options.directLookupHit !== false;
  const aliasRow = options.aliasRow || null;
  const existingDeliveries = options.existingDeliveries || {};
  const commandStatus = options.commandStatus || 'sent';
  const capabilitySchemaReady = options.capabilitySchemaReady !== false;
  const capabilityMigrationRecorded = options.capabilityMigrationRecorded !== false;
  let batchSequence = 1;
  const storedDeliveries = new Map();
  Object.keys(existingDeliveries).forEach(deliveryId => {
    storedDeliveries.set(deliveryId, existingDeliveries[deliveryId]);
  });
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        if (!Array.isArray(captures.txStatements)) {
          captures.txStatements = [];
        }
        captures.txStatements.push(text);
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("to_regclass('public.agent_runtime_capability_reported_state')")) {
        captures.capabilitySchemaGuardQueried = true;
        return {
          rows: [{
            agent_runtime_capability_table: capabilitySchemaReady
              ? 'public.agent_runtime_capability_reported_state'
              : null,
            device_runtime_capability_table: capabilitySchemaReady
              ? 'public.device_runtime_capability_reported_state'
              : null,
            schema_migrations_table: 'public.schema_migrations'
          }]
        };
      }
      if (text.includes('FROM public.schema_migrations') && text.includes('WHERE filename = $1')) {
        captures.capabilitySchemaMigrationQuery = params[0];
        return {
          rows: capabilityMigrationRecorded ? [{ '?column?': 1 }] : []
        };
      }
      if (text.includes('SELECT device_uid') && text.includes('FROM devices') && text.includes('device_uid = $2')) {
        captures.canonicalLookupInput = params[1];
        if (directLookupHit) {
          return {
            rows: [{
              device_uid: canonicalDeviceUid
            }]
          };
        }
        return { rows: [] };
      }
      if (text.includes('FROM device_identity_aliases')) {
        captures.aliasLookupInput = params[1];
        if (!aliasRow) {
          return { rows: [] };
        }
        return {
          rows: [{
            canonical_device_uid: aliasRow.canonical_device_uid || canonicalDeviceUid,
            alias_kind: aliasRow.alias_kind || 'device_uid',
            status: aliasRow.status || 'active'
          }]
        };
      }
      if (text.includes('SELECT')
        && text.includes('FROM devices')
        && text.includes('managed_status')
        && text.includes('discovery_metadata')) {
        captures.managedLookupUid = params[1];
        return {
          rows: [{
            company_id: 'DEFAULT',
            device_uid: canonicalDeviceUid,
            provider: 'zkteco',
            managed_status: 'managed',
            active: true,
            metadata: {},
            discovery_metadata: {}
          }]
        };
      }
      if (text.includes('INSERT INTO agent_device_sync_states')) {
        captures.syncStateDeviceUid = params[2];
        return {
          rows: [{
            id: 'sync-1'
          }]
        };
      }
      if (text.includes('FROM agent_device_event_batches')
        && text.includes('delivery_id = $3')) {
        captures.deliveryLookup = {
          companyId: params[0],
          agentId: params[1],
          deliveryId: params[2]
        };
        const existing = storedDeliveries.get(params[2]);
        if (!existing) {
          return { rows: [] };
        }
        return {
          rows: [{
            id: existing.id || 'batch-existing',
            delivery_id: params[2],
            status: existing.status || 'accepted',
            failure_reason: existing.failure_reason || null,
            inserted_count: existing.inserted_count || 0,
            deduped_count: existing.deduped_count || 0,
            rejected_count: existing.rejected_count || 0,
            latest_event_time_utc: existing.latest_event_time_utc || null,
            payload: existing.payload || {
              summary: { pull_ok: true },
              rejection_samples: []
            }
          }]
        };
      }
      if (text.includes('SELECT status')
        && text.includes('FROM agent_commands')
        && text.includes('command_type = $4')) {
        captures.commandStatusLookup = {
          commandId: params[0],
          companyId: params[1],
          agentId: params[2],
          commandType: params[3]
        };
        return {
          rows: [{
            status: commandStatus
          }]
        };
      }
      if (text.includes('INSERT INTO agent_device_event_batches')) {
        captures.batchInsertDeviceUid = params[2];
        captures.batchInsertDeliveryId = params[3];
        const generatedBatchId = `batch-${batchSequence}`;
        batchSequence += 1;
        if (params[3]) {
          storedDeliveries.set(params[3], {
            id: generatedBatchId,
            status: 'accepted',
            failure_reason: null,
            inserted_count: 0,
            deduped_count: 0,
            rejected_count: 0,
            latest_event_time_utc: null,
            payload: {}
          });
        }
        return {
          rows: [{ id: generatedBatchId }]
        };
      }
      if (text.includes('FROM identity_mappings')) {
        const identifierValue = params[3];
        if (Object.prototype.hasOwnProperty.call(identityLookup, identifierValue)) {
          const mappedPersonId = identityLookup[identifierValue];
          if (!mappedPersonId) {
            return { rows: [] };
          }
          return { rows: [{ person_id: mappedPersonId }] };
        }
        return { rows: [{ person_id: identifierValue }] };
      }
      if (text.includes('INSERT INTO device_events')) {
        captures.eventInsertDeviceUid = params[5];
        const identifierValue = params[12];
        const rowCount = Object.prototype.hasOwnProperty.call(insertRowCountByIdentifier, identifierValue)
          ? insertRowCountByIdentifier[identifierValue]
          : 0;
        return {
          rows: rowCount === 1 ? [{ id: 'event-1' }] : [],
          rowCount
        };
      }
      if (text.includes('DELETE FROM attendance_days')) {
        captures.cacheInvalidationCalled = true;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('UPDATE agent_device_event_batches')) {
        captures.batchUpdate = {
          latestEventTimeUtc: params[0],
          insertedCount: params[1],
          dedupedCount: params[2],
          rejectedCount: params[3],
          status: params[4],
          failureReason: params[5]
        };
        for (const [deliveryId, record] of storedDeliveries.entries()) {
          if (record.id === params[7]) {
            storedDeliveries.set(deliveryId, {
              ...record,
              status: params[4],
              failure_reason: params[5],
              inserted_count: params[1],
              deduped_count: params[2],
              rejected_count: params[3],
              latest_event_time_utc: params[0],
              payload: {
                ...(record.payload || {}),
                ...(JSON.parse(params[6] || '{}'))
              }
            });
          }
        }
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('UPDATE agent_device_sync_states')) {
        captures.syncUpdate = {
          status: params[0],
          cursorEventTimeUtc: params[1],
          pullCount: params[3],
          submitCount: params[4],
          failureReason: params[5]
        };
        captures.syncUpdateDeviceUid = params[9];
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FROM device_runtime_reported_state')
        && text.includes('WHERE company_id = $1')
        && text.includes('device_uid = $2')) {
        captures.reportedStateLookupDeviceUid = params[1];
        return { rows: [] };
      }
      if (text.includes('INSERT INTO device_runtime_reported_state')) {
        captures.reportedStateUpsert = {
          companyId: params[0],
          deviceUid: params[1],
          siteId: params[2],
          reportingAgentId: params[3],
          lastPullStatus: params[6],
          reportedHealthStatus: params[10],
          reportedHealthReason: params[11]
        };
        return {
          rows: [{
            company_id: params[0],
            device_uid: params[1]
          }],
          rowCount: 1
        };
      }
      if (text.includes('FROM device_runtime_capability_reported_state')
        && text.includes('WHERE company_id = $1')
        && text.includes('device_uid = $2')
        && text.includes('capability_key = $3')) {
        captures.deviceCapabilityLookup = {
          companyId: params[0],
          deviceUid: params[1],
          capabilityKey: params[2]
        };
        return { rows: [] };
      }
      if (text.includes('INSERT INTO device_runtime_capability_reported_state')) {
        captures.deviceCapabilityUpsert = {
          companyId: params[0],
          deviceUid: params[1],
          siteId: params[2],
          reportingAgentId: params[3],
          capabilityKey: params[4],
          capabilityStatus: params[5],
          capabilityReason: params[6]
        };
        return {
          rows: [{
            company_id: params[0],
            device_uid: params[1],
            capability_key: params[4],
            capability_status: params[5]
          }],
          rowCount: 1
        };
      }
      if (text.includes('UPDATE devices') && text.includes('manageability_status = CASE')) {
        captures.manageabilityUpdate = {
          status: params[0],
          reason: params[1],
          proven: params[2],
          proofAtUtc: params[3]
        };
        captures.manageabilityDeviceUid = params[5];
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('UPDATE devices') && text.includes('SET last_seen_at')) {
        captures.updatedDeviceLastSeen = true;
        captures.lastSeenDeviceUid = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('UPDATE agent_commands') && text.includes("command_type = $5")) {
        captures.commandAck = JSON.parse(params[0]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query in ingest test: ${text.slice(0, 120)}`);
    }
  };
}

function createRecentEventsDbMock(captures, options = {}) {
  const canonicalDeviceUid = options.canonicalDeviceUid || 'zkteco:sn:ABC001';
  const directLookupHit = options.directLookupHit !== false;
  const aliasRow = options.aliasRow || null;
  const rows = Array.isArray(options.rows) ? options.rows : [];

  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (text.includes('SELECT device_uid, identity_status, superseded_by_device_uid')
        && text.includes('FROM devices')
        && text.includes('device_uid = $2')) {
        captures.canonicalLookupInput = params[1];
        if (!directLookupHit) {
          return { rows: [] };
        }
        return {
          rows: [{
            device_uid: canonicalDeviceUid,
            identity_status: 'canonical',
            superseded_by_device_uid: null
          }]
        };
      }
      if (text.includes('FROM device_identity_aliases')) {
        captures.aliasLookupInput = params[1];
        if (!aliasRow) {
          return { rows: [] };
        }
        return {
          rows: [{
            canonical_device_uid: aliasRow.canonical_device_uid || canonicalDeviceUid,
            alias_kind: aliasRow.alias_kind || 'device_uid',
            status: aliasRow.status || 'active'
          }]
        };
      }
      if (text.includes('FROM device_events e') && text.includes('ORDER BY e.event_time_utc DESC')) {
        captures.recentEventsParams = params;
        return { rows };
      }
      throw new Error(`unexpected query in recent-events test: ${text.slice(0, 120)}`);
    }
  };
}

async function runListRecentDeviceEventsAliasCase() {
  const captures = {};
  const aliasUid = 'zkteco:ip:192.168.1.99';
  const canonicalUid = 'zkteco:sn:ABC001';
  const db = createRecentEventsDbMock(captures, {
    directLookupHit: false,
    canonicalDeviceUid: canonicalUid,
    aliasRow: {
      canonical_device_uid: canonicalUid,
      alias_kind: 'device_uid',
      status: 'active'
    },
    rows: [{
      id: 'event-1',
      company_id: 'DEFAULT',
      device_uid: canonicalUid,
      person_id: 'P001',
      device_person_id: 'P001',
      event_time_utc: '2026-03-18T10:00:00.000Z',
      event_time_local: '2026-03-18 11:00:00',
      direction: 'IN',
      verify_state: '0',
      verify_method: 'finger',
      vendor: 'zkteco',
      created_at: '2026-03-18T10:00:01.000Z'
    }]
  });

  const result = await service.listRecentDeviceEvents(db, {
    companyId: 'DEFAULT',
    deviceUid: aliasUid,
    limit: 20
  });

  assert.strictEqual(result.requested_device_uid, aliasUid);
  assert.strictEqual(result.canonical_device_uid, canonicalUid);
  assert.strictEqual(result.canonical_resolved_by, 'alias');
  assert.strictEqual(captures.aliasLookupInput, aliasUid);
  assert.strictEqual(captures.recentEventsParams[1], canonicalUid, 'recent events query should target canonical device uid');
  assert.strictEqual(result.rows.length, 1);
}

async function runListRecentDeviceEventsCompanyWideCase() {
  const captures = {};
  const db = createRecentEventsDbMock(captures, {
    rows: [{
      id: 'event-2',
      company_id: 'DEFAULT',
      device_uid: 'zkteco:sn:ANY',
      person_id: 'P002',
      device_person_id: 'P002',
      event_time_utc: '2026-03-18T11:00:00.000Z',
      event_time_local: '2026-03-18 12:00:00',
      direction: 'OUT',
      verify_state: '1',
      verify_method: 'card',
      vendor: 'zkteco',
      created_at: '2026-03-18T11:00:01.000Z'
    }]
  });

  const result = await service.listRecentDeviceEvents(db, {
    companyId: 'DEFAULT',
    limit: 5
  });

  assert.strictEqual(result.requested_device_uid, null);
  assert.strictEqual(result.canonical_device_uid, null);
  assert.strictEqual(captures.canonicalLookupInput, undefined, 'company-wide query should not trigger canonical lookup');
  assert.strictEqual(captures.recentEventsParams.length, 2, 'company-wide query should include only company + limit params');
  assert.strictEqual(result.rows.length, 1);
}

async function runQueueCommandCase() {
  const captures = {};
  const db = createQueueDbMock(captures);
  const result = await service.queuePullDeviceEventsCommand(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    deviceUid: 'zkteco:sn:ABC001',
    options: {
      lookback_minutes: 60,
      safety_window_minutes: 5,
      command_ttl_seconds: 60,
      sent_stale_seconds: 30
    },
    createdByKeyId: 'key-1'
  });

  assert.ok(result.value, 'queue command should succeed');
  assert.strictEqual(captures.commandDeviceUid, 'zkteco:sn:ABC001', 'queue should keep canonical uid for direct lookup');
  assert.strictEqual(captures.commandPayload.connection.host, '192.168.1.20');
  assert.strictEqual(captures.commandPayload.connection.port, 4370);
  assert.strictEqual(captures.commandPayload.connection.auth_password, 4321);
  assert.ok(
    captures.commandPayload.pull.requested_since_utc.startsWith('2026-03-06T09:55:'),
    'requested_since should apply safety window from cursor'
  );
  assert.strictEqual(captures.commandPayload.pull.sent_stale_seconds, 30);
  assert.strictEqual(captures.commandTtlSeconds, '60');
  assert.strictEqual(captures.syncStateDeviceUid, 'zkteco:sn:ABC001', 'sync state should use canonical uid');
  assert.strictEqual(captures.inFlightDeviceUid, 'zkteco:sn:ABC001', 'in-flight guard should use canonical uid');
  assert.strictEqual(captures.syncUpdateDeviceUid, 'zkteco:sn:ABC001', 'sync metadata update should target canonical uid');
  assert.strictEqual(captures.syncUpdateMetadata.last_queued_command_id, 'cmd-1');
  assert.ok(!captures.syncUpdateQuery.includes("status = 'syncing'"), 'queue should no longer set syncing status');
}

async function runQueueAliasResolutionCase() {
  const captures = {};
  const aliasUid = 'zkteco:ip:192.168.1.20';
  const canonicalUid = 'zkteco:sn:ABC001';
  const db = createQueueDbMock(captures, {
    directLookupHit: false,
    canonicalDeviceUid: canonicalUid,
    aliasRow: {
      canonical_device_uid: canonicalUid,
      alias_kind: 'device_uid',
      status: 'active'
    }
  });

  const result = await service.queuePullDeviceEventsCommand(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    deviceUid: aliasUid,
    options: {
      lookback_minutes: 60,
      safety_window_minutes: 5
    },
    createdByKeyId: 'key-1'
  });

  assert.ok(result.value, 'alias queue should succeed');
  assert.strictEqual(captures.canonicalLookupInput, aliasUid, 'direct lookup should check requested uid first');
  assert.strictEqual(captures.aliasLookupInput, aliasUid, 'alias lookup should use requested uid');
  assert.strictEqual(captures.managedLookupUid, canonicalUid, 'managed lookup should use resolved canonical uid');
  assert.strictEqual(captures.commandDeviceUid, canonicalUid, 'queued command should write canonical uid');
  assert.strictEqual(captures.syncStateDeviceUid, canonicalUid, 'sync state should write canonical uid');
  assert.strictEqual(captures.inFlightDeviceUid, canonicalUid, 'in-flight guard should use canonical uid');
  assert.strictEqual(captures.syncUpdateDeviceUid, canonicalUid, 'sync metadata update should target canonical uid');
}

async function runQueueSupersededAliasResolutionCase() {
  const captures = {};
  const aliasUid = 'legacy:k80-pro:ip:192.168.1.20';
  const canonicalUid = 'zkteco:sn:ABC001';
  const db = createQueueDbMock(captures, {
    directLookupHit: false,
    canonicalDeviceUid: canonicalUid,
    aliasRow: {
      canonical_device_uid: canonicalUid,
      alias_kind: 'legacy',
      status: 'superseded'
    }
  });

  const result = await service.queuePullDeviceEventsCommand(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    deviceUid: aliasUid,
    options: {
      lookback_minutes: 60,
      safety_window_minutes: 5
    },
    createdByKeyId: 'key-1'
  });

  assert.ok(result.value, 'superseded alias queue should still resolve to canonical');
  assert.strictEqual(captures.aliasLookupInput, aliasUid);
  assert.strictEqual(captures.commandDeviceUid, canonicalUid);
}

async function runQueueMissingBindingCase() {
  const captures = {};
  const db = createQueueDbMock(captures, {
    activeBindingRow: null
  });

  const result = await service.queuePullDeviceEventsCommand(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    deviceUid: 'zkteco:sn:ABC001',
    options: {
      lookback_minutes: 60,
      safety_window_minutes: 5
    },
    createdByKeyId: 'key-1'
  });

  assert.strictEqual(result.error, 'device_managing_agent_binding_missing', 'queue should fail when no active managing binding exists');
  assert.strictEqual(result.value.canonical_device_uid, 'zkteco:sn:ABC001');
  assert.strictEqual(captures.bindingLookupDeviceUid, 'zkteco:sn:ABC001');
  assert.strictEqual(captures.commandPayload, undefined, 'queue should not write command when binding is missing');
}

async function runQueueAliasBindingConflictCase() {
  const captures = {};
  const aliasUid = 'zkteco:ip:192.168.1.20';
  const canonicalUid = 'zkteco:sn:ABC001';
  const db = createQueueDbMock(captures, {
    directLookupHit: false,
    canonicalDeviceUid: canonicalUid,
    aliasRow: {
      canonical_device_uid: canonicalUid,
      alias_kind: 'device_uid',
      status: 'active'
    },
    activeBindingRow: {
      id: 'binding-2',
      company_id: 'DEFAULT',
      device_uid: canonicalUid,
      agent_id: 'agent-9',
      status: 'active',
      bound_at: '2026-03-18T00:00:00.000Z',
      updated_at: '2026-03-18T00:00:00.000Z'
    }
  });

  const result = await service.queuePullDeviceEventsCommand(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    deviceUid: aliasUid,
    options: {
      lookback_minutes: 60,
      safety_window_minutes: 5
    },
    createdByKeyId: 'key-1'
  });

  assert.strictEqual(result.error, 'device_managing_agent_binding_conflict', 'alias queue should fail with deterministic conflict when bound to another agent');
  assert.strictEqual(result.value.requested_device_uid, aliasUid);
  assert.strictEqual(result.value.canonical_device_uid, canonicalUid);
  assert.strictEqual(result.value.requested_agent_id, 'agent-1');
  assert.strictEqual(result.value.bound_agent_id, 'agent-9');
  assert.strictEqual(captures.commandPayload, undefined, 'queue should not write command on binding conflict');
}

async function runQueueSupersededWithoutCanonicalCase() {
  const captures = {};
  const supersededUid = 'zkteco:legacy:old-uid';
  const db = createQueueDbMock(captures, {
    directLookupRow: {
      device_uid: supersededUid,
      identity_status: 'superseded',
      superseded_by_device_uid: null
    }
  });

  const result = await service.queuePullDeviceEventsCommand(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    deviceUid: supersededUid,
    options: {
      lookback_minutes: 60,
      safety_window_minutes: 5
    },
    createdByKeyId: 'key-1'
  });

  assert.strictEqual(result.error, 'device_uid_superseded_without_canonical', 'queue should fail with deterministic superseded-without-canonical error');
  assert.strictEqual(result.value.requested_device_uid, supersededUid);
  assert.strictEqual(captures.commandPayload, undefined, 'queue should not write command when superseded uid has no canonical target');
}

async function runInFlightDedupeCase() {
  const captures = {
    inFlightRow: {
      id: 'cmd-inflight',
      status: 'sent'
    }
  };
  const db = createQueueDbMock(captures);
  const result = await service.queuePullDeviceEventsCommand(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    deviceUid: 'zkteco:sn:ABC001',
    options: {
      lookback_minutes: 60,
      safety_window_minutes: 5
    },
    createdByKeyId: 'key-1'
  });

  assert.strictEqual(result.error, service.PULL_COMMAND_INFLIGHT_ERROR, 'in-flight dedupe guard should block duplicate pull command');
  assert.ok(result.value && result.value.command_id === 'cmd-inflight', 'in-flight dedupe should expose existing command');
}

async function runEmptyBatchStatusCase() {
  const capturesOk = {};
  const dbOk = createIngestDbMock(capturesOk);
  const accepted = await service.ingestAgentEventBatch(dbOk, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    payload: {
      command_id: 'cmd-1',
      run_id: 'run-1',
      device_uid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingest_method: 'agent_pull',
      device_timezone: 'Africa/Tunis',
      pull_started_at: '2026-03-06T10:00:00Z',
      pull_completed_at: '2026-03-06T10:01:00Z',
      cursor: {
        requested_since_utc: '2026-03-06T09:00:00Z',
        latest_event_time_utc: null,
        has_more: false
      },
      summary: {
        pull_ok: true
      },
      events: []
    }
  });
  assert.ok(accepted.value, 'accepted empty batch should succeed');
  assert.strictEqual(capturesOk.batchUpdate.status, 'accepted');
  assert.strictEqual(capturesOk.syncUpdate.status, 'idle');
  assert.strictEqual(capturesOk.manageabilityUpdate.status, 'manageable');
  assert.strictEqual(capturesOk.manageabilityUpdate.reason, 'pull_succeeded');
  assert.strictEqual(capturesOk.commandAck.batch_status, 'accepted');
  assert.strictEqual(capturesOk.reportedStateLookupDeviceUid, 'zkteco:sn:ABC001');
  assert.strictEqual(capturesOk.reportedStateUpsert.lastPullStatus, 'accepted');
  assert.strictEqual(capturesOk.reportedStateUpsert.reportedHealthStatus, 'healthy');

  const capturesFail = {};
  const dbFail = createIngestDbMock(capturesFail);
  const rejected = await service.ingestAgentEventBatch(dbFail, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    payload: {
      command_id: 'cmd-2',
      run_id: 'run-2',
      device_uid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingest_method: 'agent_pull',
      device_timezone: 'Africa/Tunis',
      pull_started_at: '2026-03-06T10:10:00Z',
      pull_completed_at: '2026-03-06T10:11:00Z',
      cursor: {
        requested_since_utc: '2026-03-06T09:00:00Z',
        latest_event_time_utc: null,
        has_more: false
      },
      summary: {
        pull_ok: false,
        diagnostics: {
          failure_reason: 'connect_timeout'
        }
      },
      events: []
    }
  });
  assert.ok(rejected.value, 'rejected empty batch should still persist');
  assert.strictEqual(capturesFail.batchUpdate.status, 'rejected');
  assert.strictEqual(capturesFail.batchUpdate.failureReason, 'connect_timeout');
  assert.strictEqual(capturesFail.syncUpdate.status, 'error');
  assert.strictEqual(capturesFail.syncUpdate.failureReason, 'connect_timeout');
  assert.strictEqual(capturesFail.manageabilityUpdate.status, 'blocked');
  assert.strictEqual(capturesFail.manageabilityUpdate.reason, 'connect_timeout');
  assert.strictEqual(capturesFail.commandAck.batch_status, 'rejected');
  assert.strictEqual(capturesFail.reportedStateUpsert.lastPullStatus, 'rejected');
  assert.strictEqual(capturesFail.reportedStateUpsert.reportedHealthStatus, 'blocked');
}

async function runRejectedIdentityMissingCursorCase() {
  const captures = {};
  const db = createIngestDbMock(captures, {
    identityLookup: {
      'PIN-MISSING': null
    }
  });
  const rejected = await withIdentityMappingsRequired(() => service.ingestAgentEventBatch(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    payload: {
      command_id: 'cmd-3',
      run_id: 'run-3',
      device_uid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingest_method: 'agent_pull',
      device_timezone: 'Africa/Tunis',
      pull_started_at: '2026-03-06T10:20:00Z',
      pull_completed_at: '2026-03-06T10:21:00Z',
      cursor: {
        requested_since_utc: '2026-03-06T09:00:00Z',
        latest_event_time_utc: '2026-03-06T10:20:00Z',
        has_more: false
      },
      summary: {
        pull_ok: true
      },
      events: [
        {
          device_person_id: 'PIN-MISSING',
          event_time_local: '2026-03-06 11:20:00',
          event_time_utc: '2026-03-06T10:20:00Z',
          direction: 'IN',
          verify_state: null,
          verify_method: null,
          raw: { source: 'test' }
        }
      ]
    }
  }));

  assert.ok(rejected.value, 'rejected identity-missing batch should return value');
  assert.strictEqual(captures.batchUpdate.status, 'rejected');
  assert.strictEqual(captures.batchUpdate.failureReason, 'identity_mapping_missing');
  assert.strictEqual(captures.batchUpdate.rejectedCount, 1);
  assert.strictEqual(captures.batchUpdate.latestEventTimeUtc, null, 'rejected identity-missing batch must not advance latest_event_time_utc');
  assert.strictEqual(captures.syncUpdate.status, 'error');
  assert.strictEqual(captures.syncUpdate.cursorEventTimeUtc, null, 'rejected identity-missing batch must not advance sync cursor');
  assert.strictEqual(captures.syncUpdate.failureReason, 'identity_mapping_missing');
  assert.strictEqual(captures.commandAck.batch_status, 'rejected');
  assert.strictEqual(captures.commandAck.latest_event_time_utc, null, 'ack payload should not report unsafe latest_event_time_utc');
  assert.strictEqual(captures.reportedStateUpsert.lastPullStatus, 'rejected');
}

async function runPartialAcceptedCursorCase() {
  const captures = {};
  const db = createIngestDbMock(captures, {
    identityLookup: {
      'PIN-ACCEPT': 'person-accept',
      'PIN-MISSING': null
    },
    insertRowCountByIdentifier: {
      'PIN-ACCEPT': 0
    }
  });
  const partial = await withIdentityMappingsRequired(() => service.ingestAgentEventBatch(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    payload: {
      command_id: 'cmd-4',
      run_id: 'run-4',
      device_uid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingest_method: 'agent_pull',
      device_timezone: 'Africa/Tunis',
      pull_started_at: '2026-03-06T10:00:00Z',
      pull_completed_at: '2026-03-06T10:30:00Z',
      cursor: {
        requested_since_utc: '2026-03-06T09:00:00Z',
        latest_event_time_utc: '2026-03-06T10:20:00Z',
        has_more: false
      },
      summary: {
        pull_ok: true
      },
      events: [
        {
          device_person_id: 'PIN-ACCEPT',
          event_time_local: '2026-03-06 11:10:00',
          event_time_utc: '2026-03-06T10:10:00Z',
          direction: 'IN',
          verify_state: null,
          verify_method: null,
          raw: { source: 'test-accept' }
        },
        {
          device_person_id: 'PIN-MISSING',
          event_time_local: '2026-03-06 11:20:00',
          event_time_utc: '2026-03-06T10:20:00Z',
          direction: 'IN',
          verify_state: null,
          verify_method: null,
          raw: { source: 'test-missing' }
        }
      ]
    }
  }));

  assert.ok(partial.value, 'partial batch should return value');
  assert.strictEqual(captures.batchUpdate.status, 'partial');
  assert.strictEqual(captures.batchUpdate.rejectedCount, 1);
  assert.strictEqual(captures.batchUpdate.dedupedCount, 1);
  assert.strictEqual(
    captures.batchUpdate.latestEventTimeUtc,
    '2026-03-06T10:10:00.000Z',
    'partial batch should only advance latest_event_time_utc to accepted evidence'
  );
  assert.strictEqual(captures.syncUpdate.status, 'idle');
  assert.strictEqual(
    captures.syncUpdate.cursorEventTimeUtc,
    '2026-03-06T10:10:00.000Z',
    'sync cursor should advance only to max accepted evidence timestamp'
  );
  assert.strictEqual(captures.commandAck.batch_status, 'partial');
  assert.strictEqual(captures.commandAck.latest_event_time_utc, '2026-03-06T10:10:00.000Z');
  assert.strictEqual(captures.reportedStateUpsert.lastPullStatus, 'partial');
  assert.strictEqual(captures.reportedStateUpsert.reportedHealthStatus, 'degraded');
}

async function runIngestAliasResolutionCase() {
  const captures = {};
  const aliasUid = 'zkteco:ip:192.168.1.99';
  const canonicalUid = 'zkteco:sn:ABC001';
  const db = createIngestDbMock(captures, {
    directLookupHit: false,
    canonicalDeviceUid: canonicalUid,
    aliasRow: {
      canonical_device_uid: canonicalUid,
      alias_kind: 'device_uid',
      status: 'active'
    },
    insertRowCountByIdentifier: {
      'PIN-ALIAS': 1
    }
  });

  const result = await service.ingestAgentEventBatch(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    payload: {
      command_id: 'cmd-alias',
      run_id: 'run-alias',
      device_uid: aliasUid,
      vendor: 'zkteco',
      ingest_method: 'agent_pull',
      device_timezone: 'Africa/Tunis',
      pull_started_at: '2026-03-06T10:00:00Z',
      pull_completed_at: '2026-03-06T10:05:00Z',
      cursor: {
        requested_since_utc: '2026-03-06T09:00:00Z',
        latest_event_time_utc: '2026-03-06T10:01:00Z',
        has_more: false
      },
      summary: {
        pull_ok: true
      },
      events: [
        {
          device_person_id: 'PIN-ALIAS',
          event_time_local: '2026-03-06 11:01:00',
          event_time_utc: '2026-03-06T10:01:00Z',
          direction: 'IN',
          verify_state: null,
          verify_method: null,
          raw: { source: 'alias-test' }
        }
      ]
    }
  });

  assert.ok(result.value, 'alias ingest should succeed');
  assert.strictEqual(captures.canonicalLookupInput, aliasUid, 'ingest should check requested uid directly first');
  assert.strictEqual(captures.aliasLookupInput, aliasUid, 'ingest should query alias table with requested uid');
  assert.strictEqual(captures.managedLookupUid, canonicalUid, 'managed device lookup should target canonical uid');
  assert.strictEqual(captures.syncStateDeviceUid, canonicalUid, 'sync state should target canonical uid');
  assert.strictEqual(captures.batchInsertDeviceUid, canonicalUid, 'batch row should persist canonical uid');
  assert.strictEqual(captures.eventInsertDeviceUid, canonicalUid, 'event row should persist canonical uid');
  assert.strictEqual(captures.syncUpdateDeviceUid, canonicalUid, 'sync update should target canonical uid');
  assert.strictEqual(captures.manageabilityDeviceUid, canonicalUid, 'manageability update should target canonical uid');
  assert.strictEqual(captures.lastSeenDeviceUid, canonicalUid, 'device last_seen update should target canonical uid');
}

async function runDeliveryReplayIdempotencyCase() {
  const captures = {};
  const deliveryId = 'delivery-replay-1';
  const db = createIngestDbMock(captures, {
    existingDeliveries: {
      [deliveryId]: {
        id: 'batch-existing-1',
        status: 'accepted',
        failure_reason: null,
        inserted_count: 4,
        deduped_count: 1,
        rejected_count: 0,
        latest_event_time_utc: '2026-03-06T10:30:00.000Z',
        payload: {
          summary: { pull_ok: true },
          rejection_samples: []
        }
      }
    }
  });

  const result = await service.ingestAgentEventBatch(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    payload: {
      command_id: 'cmd-replay',
      delivery_id: deliveryId,
      delivery_attempt: 2,
      run_id: 'run-replay',
      device_uid: 'zkteco:sn:ABC001',
      vendor: 'zkteco',
      ingest_method: 'agent_pull',
      device_timezone: 'Africa/Tunis',
      pull_started_at: '2026-03-06T10:20:00Z',
      pull_completed_at: '2026-03-06T10:21:00Z',
      cursor: {
        requested_since_utc: '2026-03-06T09:00:00Z',
        latest_event_time_utc: '2026-03-06T10:30:00Z',
        has_more: false
      },
      summary: {
        pull_ok: true
      },
      events: [
        {
          device_person_id: 'PIN-REPLAY',
          event_time_local: '2026-03-06 11:30:00',
          event_time_utc: '2026-03-06T10:30:00Z',
          direction: 'IN',
          verify_state: null,
          verify_method: null,
          raw: { source: 'replay' }
        }
      ]
    }
  });

  assert.ok(result.value, 'delivery replay should return value');
  assert.strictEqual(result.value.replayed_delivery, true, 'delivery replay should be explicit');
  assert.strictEqual(result.value.batch_id, 'batch-existing-1', 'delivery replay should return existing batch id');
  assert.strictEqual(result.value.inserted_count, 4, 'delivery replay should reuse existing counts');
  assert.strictEqual(captures.batchInsertDeviceUid, undefined, 'delivery replay should skip new batch insert');
}

async function runIngestSchemaGuardMissingCase() {
  const captures = {};
  const db = createIngestDbMock(captures, {
    capabilitySchemaReady: false,
    capabilityMigrationRecorded: false
  });
  let thrown = null;
  try {
    await service.ingestAgentEventBatch(db, {
      companyId: 'DEFAULT',
      agentId: 'agent-1',
      payload: {
        command_id: 'cmd-schema',
        run_id: 'run-schema',
        device_uid: 'zkteco:sn:ABC001',
        vendor: 'zkteco',
        ingest_method: 'agent_pull',
        device_timezone: 'Africa/Tunis',
        pull_started_at: '2026-03-06T10:00:00Z',
        pull_completed_at: '2026-03-06T10:01:00Z',
        cursor: {
          requested_since_utc: '2026-03-06T09:00:00Z',
          latest_event_time_utc: null,
          has_more: false
        },
        summary: {
          pull_ok: true
        },
        events: []
      }
    });
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'ingest should throw runtime schema guard error when capability tables are missing');
  assert.strictEqual(thrown.code, 'RUNTIME_SCHEMA_NOT_READY');
  assert.strictEqual(thrown.details.runtime_path, '/api/agent/device-events/batch');
  assert.ok(thrown.details.missing_relations.includes('public.agent_runtime_capability_reported_state'));
  assert.ok(thrown.details.missing_relations.includes('public.device_runtime_capability_reported_state'));
  assert.deepStrictEqual(captures.txStatements, ['BEGIN', 'ROLLBACK'], 'schema guard failure should rollback transaction');
  assert.strictEqual(captures.batchInsertDeviceUid, undefined, 'schema guard failure should not persist a batch row');
  assert.strictEqual(captures.eventInsertDeviceUid, undefined, 'schema guard failure should not persist event rows');
  assert.strictEqual(captures.capabilitySchemaGuardQueried, true, 'ingest should run capability schema guard before mutations');
}

function createProbeResultDbMock(captures, options = {}) {
  const commandPayload = options.commandPayload || {
    device_uid: 'zkteco:sn:ABC001',
    runtime_context: { site_id: 'site-1' },
    capability_refresh: { probe_mode: 'bounded_pull_path_probe_v1' }
  };
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM agent_commands') && text.includes('command_type = $4')) {
        return {
          rows: [{
            id: 'probe-cmd-1',
            command_payload: commandPayload,
            status: 'sent'
          }]
        };
      }
      if (text.includes('UPDATE agent_commands') && text.includes("status = 'acknowledged'")) {
        captures.commandAcknowledged = true;
        captures.commandResultPayload = JSON.parse(params[0]);
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("to_regclass('public.agent_runtime_capability_reported_state')")) {
        captures.capabilitySchemaGuardQueried = true;
        return {
          rows: [{
            agent_runtime_capability_table: 'public.agent_runtime_capability_reported_state',
            device_runtime_capability_table: 'public.device_runtime_capability_reported_state',
            schema_migrations_table: 'public.schema_migrations'
          }]
        };
      }
      if (text.includes('FROM public.schema_migrations') && text.includes('WHERE filename = $1')) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (text.includes('FROM device_runtime_capability_reported_state')) {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO device_runtime_capability_reported_state')) {
        captures.capabilityUpsert = {
          company_id: params[0],
          device_uid: params[1],
          site_id: params[2],
          reporting_agent_id: params[3],
          capability_key: params[4],
          capability_status: params[5],
          capability_reason: params[6],
          reported_at: params[7],
          metadata: JSON.parse(params[8])
        };
        return {
          rows: [{
            company_id: params[0],
            device_uid: params[1],
            site_id: params[2],
            reporting_agent_id: params[3],
            capability_key: params[4],
            capability_status: params[5],
            capability_reason: params[6],
            reported_at: params[7],
            metadata: JSON.parse(params[8])
          }]
        };
      }
      throw new Error(`unexpected query in probe result mock: ${text.slice(0, 140)}`);
    }
  };
}

async function runProbeResultFailureDoesNotMarkCapabilitySupportedCase() {
  const captures = {};
  const db = createProbeResultDbMock(captures);
  const result = await service.ingestDevicePathPullCapabilityProbeResult(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    payload: {
      command_id: 'probe-cmd-1',
      device_uid: 'zkteco:sn:ABC001',
      completed_at: '2026-05-06T08:00:00.000Z',
      result: {
        success: false,
        reason_code: 'attlog_stage_failed',
        diagnostics: { pull_ok: false }
      }
    }
  });

  assert.ok(result.value, 'failed probe should still acknowledge command result');
  assert.strictEqual(result.value.capability_status, 'unknown');
  assert.strictEqual(captures.commandAcknowledged, true);
  assert.strictEqual(captures.capabilityUpsert, undefined, 'failed probe must not mark pull capability supported');
}

async function runProbeResultSuccessMarksCapabilitySupportedCase() {
  const captures = {};
  const db = createProbeResultDbMock(captures);
  const result = await service.ingestDevicePathPullCapabilityProbeResult(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    payload: {
      command_id: 'probe-cmd-1',
      device_uid: 'zkteco:sn:ABC001',
      completed_at: '2026-05-06T08:00:00.000Z',
      result: {
        success: true,
        reason_code: 'fresh_pull_path_probe_succeeded',
        diagnostics: { pull_ok: true, final_attlog_payload_bytes: 4124 }
      }
    }
  });

  assert.ok(result.value);
  assert.strictEqual(result.value.capability_status, 'supported');
  assert.strictEqual(captures.capabilityUpsert.capability_key, 'device_path.pull_device_events');
  assert.strictEqual(captures.capabilityUpsert.capability_status, 'supported');
  assert.strictEqual(captures.capabilityUpsert.capability_reason, 'fresh_pull_path_probe_succeeded');
  assert.strictEqual(captures.capabilityUpsert.reported_at, '2026-05-06T08:00:00.000Z');
  assert.strictEqual(captures.capabilityUpsert.metadata.source, 'agent.device_path_pull_capability_probe_result');
  assert.strictEqual(captures.capabilityUpsert.metadata.command_id, 'probe-cmd-1');
}

function runHelperCases() {
  assert.strictEqual(service.__test.parseIntegerField(' 1234 '), 1234);
  assert.strictEqual(service.__test.parseIntegerField('abc'), null);

  const auth = service.__test.resolveConnectionAuthPassword({
    metadata: { auth_password: 1111 },
    discovery_metadata: { auth_password: 2222 }
  }, {
    auth_password: 3333
  });
  assert.strictEqual(auth, 3333, 'option auth password should take precedence');

  const maxIso = service.__test.getMaxIsoUtc([
    'invalid',
    '2026-03-06T10:00:00Z',
    '2026-03-06T11:00:00Z'
  ]);
  assert.strictEqual(maxIso, '2026-03-06T11:00:00.000Z');

  const metadataPort = service.__test.resolveConnectionPort({
    metadata: { port: 4388 },
    discovery_metadata: {}
  }, {});
  assert.strictEqual(metadataPort, 4388, 'metadata.port should be used when discovery port is absent');

  const metadataConnectionPort = service.__test.resolveConnectionPort({
    metadata: { connection: { port: 4390 } },
    discovery_metadata: {}
  }, {});
  assert.strictEqual(
    metadataConnectionPort,
    4390,
    'metadata.connection.port should be used when root metadata.port is absent'
  );

  const rtDiagnostics = service.__test.summarizeRealtimeBatchDiagnostics({
    summary: {
      ingest_method: 'agent_realtime',
      events_received_count: 1,
      inserted_count: 0,
      diagnostics: {
        k80_rt_ingest_policy_enabled: false,
        k80_rt_ingest_insert_path_skipped: true,
        k80_rt_ingest_insert_path_skip_reason: 'k80_rt_ingest_policy_disabled'
      }
    },
    events: [{ id: 'rt-1' }]
  });
  assert.deepStrictEqual(rtDiagnostics, {
    ingest_method: 'agent_realtime',
    events_received_count: 1,
    inserted_count: 0,
    k80_rt_ingest_policy_enabled: false,
    k80_rt_ingest_insert_path_skipped: true,
    k80_rt_ingest_insert_path_skip_reason: 'k80_rt_ingest_policy_disabled'
  });

  const nonRtDiagnostics = service.__test.summarizeRealtimeBatchDiagnostics({
    summary: {
      ingest_method: 'full_history_pull',
      inserted_count: 2
    }
  });
  assert.strictEqual(nonRtDiagnostics, null, 'non-realtime batches should not expose RT diagnostics');
}

async function run() {
  runHelperCases();
  await runListRecentDeviceEventsAliasCase();
  await runListRecentDeviceEventsCompanyWideCase();
  await runQueueCommandCase();
  await runQueueAliasResolutionCase();
  await runQueueSupersededAliasResolutionCase();
  await runQueueMissingBindingCase();
  await runQueueAliasBindingConflictCase();
  await runQueueSupersededWithoutCanonicalCase();
  await runInFlightDedupeCase();
  await runEmptyBatchStatusCase();
  await runRejectedIdentityMissingCursorCase();
  await runPartialAcceptedCursorCase();
  await runIngestAliasResolutionCase();
  await runDeliveryReplayIdempotencyCase();
  await runIngestSchemaGuardMissingCase();
  await runProbeResultFailureDoesNotMarkCapabilitySupportedCase();
  await runProbeResultSuccessMarksCapabilitySupportedCase();
  console.log('agent device events service tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
