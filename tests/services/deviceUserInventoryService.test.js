const assert = require('assert');
const service = require('../../services/deviceUserInventoryService');

async function run() {
  const captures = {};
  const db = {
    query: async (sql, params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO device_user_inventory_snapshots')) {
        captures.insertParams = params;
        return {
          rows: [{
            id: 'c03f13cc-c5e4-4e5a-a68f-7f447c8db2f1',
            company_id: params[0],
            device_uid: params[1],
            inventory_scope: params[2],
            snapshot_taken_at: params[3],
            raw_evidence_ref: JSON.parse(params[4]),
            parsed_device_user_ids: JSON.parse(params[5]),
            parsed_user_count: params[6],
            inventory_confidence_status: params[7],
            inventory_completeness_status: params[8],
            next_candidate_device_user_id: params[9],
            allocation_strategy: params[10],
            strategy_version: params[11],
            notes: params[12],
            source_metadata: JSON.parse(params[13]),
            superseded_by_snapshot_id: null,
            created_by: params[14],
            created_at: '2026-04-14T14:00:00.000Z',
            updated_at: '2026-04-14T14:00:00.000Z'
          }]
        };
      }
      if (text.includes('FROM device_user_inventory_snapshots')) {
        captures.lookupParams = params;
        return {
          rows: [{
            id: 'latest-1',
            company_id: params[0],
            device_uid: params[1],
            inventory_scope: params[2],
            snapshot_taken_at: '2026-04-14T14:05:00.000Z',
            raw_evidence_ref: { source: 'users.pcapng' },
            parsed_device_user_ids: [1, 2, 3],
            parsed_user_count: 3,
            inventory_confidence_status: 'high',
            inventory_completeness_status: 'complete',
            next_candidate_device_user_id: null,
            allocation_strategy: null,
            strategy_version: null,
            notes: null,
            source_metadata: {},
            superseded_by_snapshot_id: null,
            created_by: 'tester',
            created_at: '2026-04-14T14:05:00.000Z',
            updated_at: '2026-04-14T14:05:00.000Z'
          }]
        };
      }
      if (text.includes('INSERT INTO device_user_id_preflight_decisions')) {
        captures.preflightInsertParams = params;
        return {
          rows: [{
            id: 'pref-1',
            company_id: params[0],
            device_uid: params[1],
            inventory_scope: params[2],
            source_inventory_snapshot_id: params[3],
            source_candidate_evaluation: JSON.parse(params[4]),
            selected_candidate_device_user_id: params[5],
            selected_source: params[6],
            preflight_readiness_status: params[7],
            blocked_reason_code: params[8],
            manual_override_used: params[9],
            manual_override_actor: params[10],
            manual_override_reason: params[11],
            manual_override_note: params[12],
            manual_override_required: params[13],
            audit_ref: params[14],
            evaluated_at: params[15],
            metadata: JSON.parse(params[16]),
            created_at: '2026-04-14T15:00:00.000Z'
          }]
        };
      }
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    }
  };

  const created = await service.createDeviceUserInventorySnapshot(db, {
    companyId: 'DEFAULT',
    deviceUid: 'zkteco:sn:BIND-QUEUE-c26a7486',
    inventoryScope: 'zk_k80',
    snapshotTakenAt: '2026-04-14T13:58:00.000Z',
    rawEvidenceRef: { capture: 'users.pcapng' },
    parsedDeviceUserIds: [7, '2', '7', '10'],
    inventoryConfidenceStatus: 'high',
    inventoryCompletenessStatus: 'partial',
    nextCandidateDeviceUserId: null,
    allocationStrategy: null,
    strategyVersion: 'phase1',
    notes: 'seed',
    sourceMetadata: { bounded: true },
    createdBy: 'tester'
  });

  assert.strictEqual(created.company_id, 'DEFAULT');
  assert.deepStrictEqual(created.parsed_device_user_ids, [2, 7, 10], 'parsed ids should normalize');
  assert.strictEqual(created.parsed_user_count, 3);
  assert.strictEqual(captures.insertParams[6], 3, 'stored parsed_user_count should match normalized ids');

  const latest = await service.getLatestDeviceUserInventorySnapshot(db, {
    companyId: 'DEFAULT',
    deviceUid: 'zkteco:sn:BIND-QUEUE-c26a7486',
    inventoryScope: 'zk_k80'
  });

  assert.strictEqual(latest.id, 'latest-1');
  assert.deepStrictEqual(captures.lookupParams, ['DEFAULT', 'zkteco:sn:BIND-QUEUE-c26a7486', 'zk_k80']);

  {
    const candidate = service.computeConservativeNextCandidateFromSnapshot({
      id: 'snap-ready',
      inventory_scope: 'zk_k80',
      parsed_device_user_ids: [1, 2, 7, 10],
      inventory_confidence_status: 'high',
      inventory_completeness_status: 'complete'
    });
    assert.strictEqual(candidate.candidate_readiness_status, 'ready');
    assert.strictEqual(candidate.candidate_device_user_id, 11);
    assert.strictEqual(candidate.requires_manual_override, false);
  }

  {
    const candidate = service.computeConservativeNextCandidateFromSnapshot({
      id: 'snap-low-conf',
      inventory_scope: 'zk_k80',
      parsed_device_user_ids: [1, 2, 7, 10],
      inventory_confidence_status: 'low',
      inventory_completeness_status: 'complete'
    });
    assert.strictEqual(candidate.candidate_readiness_status, 'blocked_insufficient_confidence');
    assert.strictEqual(candidate.candidate_device_user_id, null);
    assert.strictEqual(candidate.requires_manual_override, true);
  }

  {
    const candidate = service.computeConservativeNextCandidateFromSnapshot({
      id: 'snap-empty',
      inventory_scope: 'zk_k80',
      parsed_device_user_ids: [],
      inventory_confidence_status: 'high',
      inventory_completeness_status: 'complete'
    });
    assert.strictEqual(candidate.candidate_readiness_status, 'blocked_invalid_parsed_ids');
  }

  {
    const candidate = service.computeConservativeNextCandidateFromSnapshot(null);
    assert.strictEqual(candidate.candidate_readiness_status, 'blocked_no_snapshot');
    assert.strictEqual(candidate.requires_manual_override, true);
  }

  {
    const snapshot = {
      id: 'snap-ready-1',
      inventory_scope: 'zk_k80',
      parsed_device_user_ids: [1, 2, 3],
      inventory_confidence_status: 'high',
      inventory_completeness_status: 'complete'
    };
    const autoCandidate = service.computeConservativeNextCandidateFromSnapshot(snapshot);
    const preflight = service.evaluateEnrollmentPreflight({
      snapshot,
      candidateEvaluation: autoCandidate,
      manualOverride: null
    });
    assert.strictEqual(preflight.preflight_readiness_status, 'ready_auto_candidate');
    assert.strictEqual(preflight.selected_candidate_device_user_id, 4);
    assert.strictEqual(preflight.selected_source, 'auto_candidate');
  }

  {
    const snapshot = {
      id: 'snap-blocked-1',
      inventory_scope: 'zk_k80',
      parsed_device_user_ids: [1, 2, 3],
      inventory_confidence_status: 'low',
      inventory_completeness_status: 'complete'
    };
    const blockedCandidate = service.computeConservativeNextCandidateFromSnapshot(snapshot);
    const preflight = service.evaluateEnrollmentPreflight({
      snapshot,
      candidateEvaluation: blockedCandidate,
      manualOverride: null
    });
    assert.strictEqual(preflight.preflight_readiness_status, 'blocked_confidence_insufficient');
    assert.strictEqual(preflight.selected_candidate_device_user_id, null);
  }

  {
    const snapshot = {
      id: 'snap-override-1',
      inventory_scope: 'zk_k80',
      parsed_device_user_ids: [1, 2, 3],
      inventory_confidence_status: 'low',
      inventory_completeness_status: 'partial'
    };
    const blockedCandidate = service.computeConservativeNextCandidateFromSnapshot(snapshot);
    const preflight = service.evaluateEnrollmentPreflight({
      snapshot,
      candidateEvaluation: blockedCandidate,
      manualOverride: {
        device_user_id: 8,
        override_reason: 'legacy_reserved',
        override_note: 'operator check'
      }
    });
    assert.strictEqual(preflight.preflight_readiness_status, 'ready_manual_override');
    assert.strictEqual(preflight.selected_candidate_device_user_id, 8);
    assert.strictEqual(preflight.selected_source, 'manual_override');
  }

  {
    const snapshot = {
      id: 'snap-override-collision',
      inventory_scope: 'zk_k80',
      parsed_device_user_ids: [1, 2, 3],
      inventory_confidence_status: 'high',
      inventory_completeness_status: 'complete'
    };
    const readyCandidate = service.computeConservativeNextCandidateFromSnapshot(snapshot);
    const preflight = service.evaluateEnrollmentPreflight({
      snapshot,
      candidateEvaluation: readyCandidate,
      manualOverride: {
        device_user_id: 3,
        override_reason: 'bad',
        override_note: 'collision'
      }
    });
    assert.strictEqual(preflight.preflight_readiness_status, 'blocked_invalid_override');
    assert.strictEqual(preflight.blocked_reason_code, 'manual_override_collides_with_known_device_user_id');
  }

  {
    const saved = await service.createEnrollmentPreflightDecision(db, {
      companyId: 'DEFAULT',
      deviceUid: 'zkteco:sn:BIND-QUEUE-c26a7486',
      inventoryScope: 'zk_k80',
      sourceInventorySnapshotId: 'latest-1',
      sourceCandidateEvaluation: { strategy_id: 'k80_max_plus_one_conservative_v1' },
      selectedCandidateDeviceUserId: 11,
      selectedSource: 'auto_candidate',
      preflightReadinessStatus: 'ready_auto_candidate',
      blockedReasonCode: null,
      manualOverrideUsed: false,
      manualOverrideActor: null,
      manualOverrideReason: null,
      manualOverrideNote: null,
      manualOverrideRequired: false,
      auditRef: 'audit-1',
      evaluatedAt: '2026-04-14T14:10:00.000Z',
      metadata: { note: 'test' }
    });
    assert.strictEqual(saved.id, 'pref-1');
    assert.strictEqual(captures.preflightInsertParams[7], 'ready_auto_candidate');
  }
}

run()
  .then(() => {
    console.log('ok - deviceUserInventoryService');
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
