const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const {
  deriveAndUpsertDirectionAttachmentForFactEvent
} = require('../../services/historicalDirectionWorkerService');

function createDbMock(captures) {
  return {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM devices') && text.includes('WHERE company_id = $1')) {
        return {
          rows: [{
            provider: 'zkteco',
            metadata: {
              device_profile: {
                model: 'K80 Pro'
              }
            }
          }]
        };
      }
      if (text.includes('FROM device_events') && text.includes('FOR UPDATE')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            event_time_utc: '2026-04-13T09:56:04.000Z',
            event_time_local: '2026-04-13 10:56:04',
            device_person_id: '3',
            person_id: '3',
            direction: 'OUT',
            dedup_key: 'dedup-1',
            source_metadata: {
              direction_contract_version: 'pull_direction_provenance_v1',
              direction_basis: 'attendance_status_map',
              direction_basis_field: 'status_code',
              direction_basis_value: 1,
              direction_flattened_value: 'OUT',
              direction_authority: 'non_authoritative',
              direction_confidence: 'low'
            },
            vendor: 'zkteco'
          }]
        };
      }
      if (text.includes('FROM device_realtime_direction_observations')) {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO derived_direction_attachments')) {
        captures.sourceRefs = JSON.parse(params[11]);
        captures.sourceMetadata = JSON.parse(params[12]);
        captures.confidenceBasis = params[9];
        captures.derivedDirection = params[6];
        return { rows: [{ id: 'attachment-1' }], rowCount: 1 };
      }
      throw new Error(`unexpected query in historical strategy test: ${text.slice(0, 80)}`);
    }
  };
}

async function run() {
  const captures = {};
  const db = createDbMock(captures);
  const result = await deriveAndUpsertDirectionAttachmentForFactEvent(
    db,
    {
      companyId: 'DEFAULT',
      agentId: 'ddc32a87-0b42-4448-bdcd-297642c66ee6',
      deviceUid: 'zkteco:sn:BIND-QUEUE-c26a7486'
    },
    {
      factEventId: '11111111-1111-1111-1111-111111111111',
      derivationRunId: 'test-run-1',
      laneSessionId: 'test-lane-1'
    }
  );

  assert.strictEqual(result.attachment_id, 'attachment-1');
  assert.strictEqual(result.confidence_basis, 'pull_status_map_fallback');
  assert.strictEqual(captures.derivedDirection, 'OUT');
  assert.strictEqual(captures.confidenceBasis, 'pull_status_map_fallback');
  assert.strictEqual(
    captures.sourceMetadata.direction_authority_strategy_resolved.strategy_id,
    'zk_k80_rt_preferred_when_eligible'
  );
  assert.strictEqual(
    captures.sourceMetadata.direction_authority_strategy_effective.strategy_id,
    'legacy_fallback_default'
  );
  assert.strictEqual(
    captures.sourceMetadata.direction_authority_strategy_effective.behavior_change_applied,
    false
  );
  assert.strictEqual(
    captures.sourceRefs.pull_direction_contract_version,
    'pull_direction_provenance_v1'
  );

  console.log('historical direction strategy plumbing test passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
