const assert = require('assert');
const service = require('../../services/deviceEnrollmentOrchestrationService');

async function run() {
  const captures = {};
  const db = {
    query: async (sql, params) => {
      const text = String(sql);
      if (text.includes('FROM device_user_id_preflight_decisions') && text.includes('ORDER BY evaluated_at DESC')) {
        captures.latestDecisionParams = params;
        return {
          rows: [{
            id: 'pref-latest-1',
            company_id: params[0],
            device_uid: params[1],
            inventory_scope: params[2],
            selected_candidate_device_user_id: 11,
            selected_source: 'auto_candidate',
            preflight_readiness_status: 'ready_auto_candidate',
            created_at: '2026-04-14T16:01:00.000Z',
            evaluated_at: '2026-04-14T16:01:00.000Z'
          }]
        };
      }
      if (text.includes('FROM device_user_id_preflight_decisions') && text.includes('id = $2::uuid')) {
        captures.preflightByIdParams = params;
        return {
          rows: [{
            id: params[1],
            company_id: params[0],
            device_uid: 'zkteco:sn:BIND-QUEUE-c26a7486',
            inventory_scope: 'zk_k80',
            selected_candidate_device_user_id: 11,
            selected_source: 'auto_candidate',
            preflight_readiness_status: 'ready_auto_candidate',
            created_at: '2026-04-14T16:01:00.000Z',
            evaluated_at: '2026-04-14T16:01:00.000Z'
          }]
        };
      }
      if (text.includes('INSERT INTO device_enrollment_attempts')) {
        captures.insertAttemptParams = params;
        return {
          rows: [{
            id: 'attempt-1',
            company_id: params[0],
            device_uid: params[1],
            inventory_scope: params[2],
            person_id: params[3],
            device_user_id: params[4],
            selected_finger: params[5],
            preflight_decision_id: params[6],
            attempt_status: params[7],
            status_reason: params[8],
            protocol_session_ref: null,
            command_ref: null,
            evidence_ref: JSON.parse(params[11]),
            source_metadata: JSON.parse(params[12]),
            started_at: params[13],
            ended_at: null,
            created_by: params[14],
            audit_ref: params[15],
            created_at: '2026-04-14T16:02:00.000Z',
            updated_at: '2026-04-14T16:02:00.000Z'
          }]
        };
      }
      if (text.includes('FROM device_enrollment_attempts')) {
        captures.getAttemptParams = params;
        return {
          rows: [{
            id: params[1],
            company_id: params[0],
            device_uid: 'zkteco:sn:BIND-QUEUE-c26a7486',
            inventory_scope: 'zk_k80',
            person_id: '99',
            device_user_id: 11,
            selected_finger: 'LEFT-INDEX',
            preflight_decision_id: 'pref-latest-1',
            attempt_status: 'pending',
            status_reason: 'awaiting_k80_protocol_execution',
            protocol_session_ref: null,
            command_ref: null,
            evidence_ref: {},
            source_metadata: {},
            started_at: '2026-04-14T16:02:00.000Z',
            ended_at: null,
            created_by: 'operator',
            audit_ref: 'audit-1',
            created_at: '2026-04-14T16:02:00.000Z',
            updated_at: '2026-04-14T16:02:00.000Z'
          }]
        };
      }
      throw new Error(`unexpected query: ${text.slice(0, 120)}`);
    }
  };

  const latest = await service.getLatestEnrollmentPreflightDecision(db, {
    companyId: 'DEFAULT',
    deviceUid: 'zkteco:sn:BIND-QUEUE-c26a7486',
    inventoryScope: 'zk_k80'
  });
  assert.strictEqual(latest.id, 'pref-latest-1');
  assert.deepStrictEqual(captures.latestDecisionParams, ['DEFAULT', 'zkteco:sn:BIND-QUEUE-c26a7486', 'zk_k80']);

  const byId = await service.getEnrollmentPreflightDecisionById(db, {
    companyId: 'DEFAULT',
    preflightDecisionId: 'pref-latest-1'
  });
  assert.strictEqual(byId.id, 'pref-latest-1');

  {
    const check = service.validatePreflightForEnrollmentStart({
      canonicalDeviceUid: 'zkteco:sn:BIND-QUEUE-c26a7486',
      inventoryScope: 'zk_k80',
      latestDecision: byId,
      selectedDecision: byId
    });
    assert.ok(check.value, 'ready preflight should pass');
    assert.strictEqual(check.value.selected_device_user_id, 11);
  }

  {
    const check = service.validatePreflightForEnrollmentStart({
      canonicalDeviceUid: 'zkteco:sn:BIND-QUEUE-c26a7486',
      inventoryScope: 'zk_k80',
      latestDecision: null,
      selectedDecision: byId
    });
    assert.strictEqual(check.error, 'preflight_decision_not_latest');
  }

  const created = await service.createEnrollmentAttempt(db, {
    companyId: 'DEFAULT',
    deviceUid: 'zkteco:sn:BIND-QUEUE-c26a7486',
    inventoryScope: 'zk_k80',
    personId: '99',
    deviceUserId: 11,
    selectedFinger: 'left-index',
    preflightDecisionId: 'pref-latest-1',
    createdBy: 'operator',
    sourceMetadata: { selected_source: 'auto_candidate' }
  });
  assert.strictEqual(created.id, 'attempt-1');
  assert.strictEqual(created.attempt_status, 'pending');
  assert.strictEqual(captures.insertAttemptParams[4], 11);

  const fetched = await service.getEnrollmentAttemptById(db, {
    companyId: 'DEFAULT',
    enrollmentAttemptId: 'attempt-1'
  });
  assert.strictEqual(fetched.id, 'attempt-1');
}

run()
  .then(() => {
    console.log('ok - deviceEnrollmentOrchestrationService');
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
