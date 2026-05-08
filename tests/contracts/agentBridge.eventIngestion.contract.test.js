const assert = require('assert');
const http = require('http');
const https = require('https');
const { adminHeaders, getCompanyId, requireAuth } = require('./_helpers/auth');

function requestJson({ method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: { ...headers }
    };

    let payload = null;
    if (body !== undefined && body !== null) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!options.headers['content-type']) {
        options.headers['content-type'] = 'application/json';
      }
      options.headers['content-length'] = Buffer.byteLength(payload);
    }

    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed = null;
        if (data) {
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            return reject(new Error(`Expected JSON response from ${url}, got: ${data.slice(0, 200)}`));
          }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function getBaseUrl() {
  return process.env.BASE_URL || 'http://localhost:3000';
}

async function ensureMode(baseUrl) {
  const res = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/ops/test/mode`,
    headers: adminHeaders()
  });
  if (res.status === 404) {
    throw new Error('ALLOW_TEST_ENDPOINTS must be enabled for this contract test');
  }
  assert.strictEqual(res.status, 200, 'mode endpoint should return 200');
}

async function run() {
  const baseUrl = getBaseUrl();
  await ensureMode(baseUrl);

  const companyId = getCompanyId();
  const runId = Math.random().toString(16).slice(2, 10);
  const deviceSerial = `EVT-${runId}`;
  const deviceUid = `zkteco:sn:${deviceSerial}`;
  const personId = `evt_person_${runId}`;
  const headers = {
    ...adminHeaders(),
    'x-company-id': companyId
  };

  const tokenRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/provisioning-tokens`,
    headers,
    body: {
      ttl_minutes: 20,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(tokenRes.status, 201, 'provisioning token create should return 201');

  const bootstrapRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/bootstrap`,
    body: {
      provisioning_token: tokenRes.body.provisioning_token,
      agent_name: `event-agent-${runId}`,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(bootstrapRes.status, 201, 'agent bootstrap should return 201');
  const agentAuthHeader = {
    authorization: `Bearer ${bootstrapRes.body.auth_token}`
  };

  const agentsOpsList = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/agents?company_id=${encodeURIComponent(companyId)}&status=active&limit=50`,
    headers
  });
  assert.strictEqual(agentsOpsList.status, 200, 'agent ops listing should return 200');
  assert.ok(Array.isArray(agentsOpsList.body.value), 'agent ops listing should return value array');
  assert.ok(
    agentsOpsList.body.value.some(row => row && row.id === bootstrapRes.body.agent_id),
    'agent ops listing should include bootstrapped agent'
  );

  const employeeRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/employees-registry/${encodeURIComponent(personId)}?company_id=${encodeURIComponent(companyId)}`,
    headers,
    body: {
      company_id: companyId,
      employee_code: `EVT${runId}`,
      full_name: 'Event Test User',
      active: true
    }
  });
  assert.strictEqual(employeeRes.status, 200, 'employee upsert should return 200');

  const mappingRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings?company_id=${encodeURIComponent(companyId)}`,
    headers,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      identifier_type: 'pin',
      identifier_value: `PIN-${runId}`,
      person_id: personId,
      active: true
    }
  });
  assert.strictEqual(mappingRes.status, 200, 'identity mapping upsert should return 200');

  const deviceRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/devices/${encodeURIComponent(deviceUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers,
    body: {
      provider: 'zkteco',
      device_name: `Event Device ${runId}`,
      active: true,
      metadata: {
        ip: '192.168.10.20'
      }
    }
  });
  assert.strictEqual(deviceRes.status, 200, 'device upsert should return 200');

  const bindRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/managing-agent-binding`,
    headers,
    body: {
      company_id: companyId,
      agent_id: bootstrapRes.body.agent_id,
      reason: 'contract_setup_binding'
    }
  });
  assert.strictEqual(bindRes.status, 200, 'managing-agent binding should return 200');
  assert.strictEqual(bindRes.body.canonical_device_uid, deviceUid, 'binding should target canonical device uid');
  assert.ok(bindRes.body.binding, 'binding response should include active binding payload');

  const queueRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(bootstrapRes.body.agent_id)}/commands/pull-device-events`,
    headers,
    body: {
      company_id: companyId,
      device_uid: deviceUid,
      options: {
        host: '192.168.10.20',
        lookback_minutes: 1440,
        safety_window_minutes: 5,
        max_events: 200,
        device_timezone: 'Africa/Tunis'
      }
    }
  });
  assert.strictEqual(queueRes.status, 201, 'queue pull command should return 201');
  assert.strictEqual(queueRes.body.command_type, 'PULL_DEVICE_EVENTS');

  const nextCommandRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: agentAuthHeader,
    body: {}
  });
  assert.strictEqual(nextCommandRes.status, 200, 'agent command poll should return 200');
  assert.ok(nextCommandRes.body.command, 'agent should receive queued command');
  assert.strictEqual(nextCommandRes.body.command.type, 'PULL_DEVICE_EVENTS');

  const failedBatch = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/device-events/batch`,
    headers: agentAuthHeader,
    body: {
      command_id: nextCommandRes.body.command.id,
      run_id: `run-failed-${runId}`,
      device_uid: deviceUid,
      vendor: 'zkteco',
      ingest_method: 'agent_pull',
      device_timezone: 'Africa/Tunis',
      pull_started_at: '2026-03-06T09:30:00Z',
      pull_completed_at: '2026-03-06T09:31:00Z',
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
  assert.strictEqual(failedBatch.status, 201, 'failed pull batch should still persist');
  assert.strictEqual(failedBatch.body.batch_status, 'rejected', 'failed pull should mark batch rejected');

  const blockedDevice = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices/${encodeURIComponent(deviceUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers
  });
  assert.strictEqual(blockedDevice.status, 200, 'device read after failed pull should return 200');
  assert.strictEqual(blockedDevice.body.manageability_status, 'blocked', 'failed pull should mark device blocked');
  assert.strictEqual(blockedDevice.body.manageability_reason, 'connect_timeout', 'failed pull reason should be carried to manageability');

  const blockedOpsDevices = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices?company_id=${encodeURIComponent(companyId)}&device_uid=${encodeURIComponent(deviceUid)}&manageability_status=blocked`,
    headers
  });
  assert.strictEqual(blockedOpsDevices.status, 200, 'ops devices blocked filter should return 200');
  assert.ok(
    Array.isArray(blockedOpsDevices.body.value)
      && blockedOpsDevices.body.value.some(row => row && row.device_uid === deviceUid),
    'blocked progression should be visible on /api/devices manageability filter'
  );

  const discoveryAfterBlocked = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/discovery-reports`,
    headers: agentAuthHeader,
    body: {
      adapter_id: 'zkteco',
      reported_at: new Date().toISOString(),
      discovered_devices: [
        {
          ip: '192.168.10.20',
          vendor: 'zkteco',
          device_uid: deviceUid,
          discovery_method: 'post_blocked_check',
          confidence: 0.4,
          confirmation_state: 'host_reachable',
          outcome_class: 'heuristic',
          observed_at: new Date().toISOString(),
          raw: {
            source: 'post_blocked_discovery'
          }
        }
      ],
      summary: {
        run_id: `post-blocked-${runId}`
      }
    }
  });
  assert.strictEqual(discoveryAfterBlocked.status, 201, 'discovery report after blocked state should be accepted');

  const blockedAfterDiscovery = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices/${encodeURIComponent(deviceUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers
  });
  assert.strictEqual(blockedAfterDiscovery.status, 200, 'device read after discovery should return 200');
  assert.strictEqual(
    blockedAfterDiscovery.body.manageability_status,
    'blocked',
    'weaker discovery observation must not clear blocked state'
  );
  assert.strictEqual(
    blockedAfterDiscovery.body.manageability_reason,
    'connect_timeout',
    'blocked reason should remain durable after weaker discovery-only update'
  );

  const queueRetryRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(bootstrapRes.body.agent_id)}/commands/pull-device-events`,
    headers,
    body: {
      company_id: companyId,
      device_uid: deviceUid,
      options: {
        host: '192.168.10.20',
        lookback_minutes: 1440,
        safety_window_minutes: 5,
        max_events: 200,
        device_timezone: 'Africa/Tunis'
      }
    }
  });
  assert.strictEqual(queueRetryRes.status, 201, 'retry queue should return 201');

  const nextRetryCommandRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: agentAuthHeader,
    body: {}
  });
  assert.strictEqual(nextRetryCommandRes.status, 200, 'retry command poll should return 200');
  assert.ok(nextRetryCommandRes.body.command, 'agent should receive retry pull command');
  assert.strictEqual(nextRetryCommandRes.body.command.type, 'PULL_DEVICE_EVENTS');

  const missingPin = `PIN-MISSING-${runId}`;
  const missingEventTimeUtc = '2026-03-06T10:05:00Z';
  const missingBatch = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/device-events/batch`,
    headers: agentAuthHeader,
    body: {
      command_id: nextRetryCommandRes.body.command.id,
      run_id: `run-missing-${runId}`,
      device_uid: deviceUid,
      vendor: 'zkteco',
      ingest_method: 'agent_pull',
      device_timezone: 'Africa/Tunis',
      pull_started_at: '2026-03-06T10:04:00Z',
      pull_completed_at: '2026-03-06T10:06:00Z',
      cursor: {
        requested_since_utc: '2026-03-06T09:00:00Z',
        latest_event_time_utc: missingEventTimeUtc,
        has_more: false
      },
      summary: {
        pull_ok: true
      },
      events: [
        {
          device_person_id: missingPin,
          event_time_local: '2026-03-06 11:05:00',
          event_time_utc: missingEventTimeUtc,
          direction: 'IN',
          raw: {
            source: 'contract_missing_mapping'
          }
        }
      ]
    }
  });
  assert.strictEqual(missingBatch.status, 201, 'missing-mapping batch should persist');
  assert.strictEqual(missingBatch.body.batch_status, 'rejected', 'missing-mapping batch should be rejected');
  assert.strictEqual(missingBatch.body.rejected_count, 1, 'missing-mapping batch should reject one event');
  assert.strictEqual(
    missingBatch.body.latest_event_time_utc,
    null,
    'missing-mapping batch should not report unsafe latest_event_time_utc'
  );

  const rejectedOpsBatches = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/device-event-batches?company_id=${encodeURIComponent(companyId)}&agent_id=${encodeURIComponent(bootstrapRes.body.agent_id)}&device_uid=${encodeURIComponent(deviceUid)}&status=rejected`,
    headers
  });
  assert.strictEqual(rejectedOpsBatches.status, 200, 'ops batch diagnostics for rejected status should return 200');
  assert.ok(Array.isArray(rejectedOpsBatches.body.value), 'ops batch diagnostics should return value array');
  const rejectedOpsRow = rejectedOpsBatches.body.value.find(
    row => row && row.command_id === nextRetryCommandRes.body.command.id
  );
  assert.ok(rejectedOpsRow, 'missing mapping rejection should be visible in batch diagnostics');
  assert.strictEqual(rejectedOpsRow.failure_reason, 'identity_mapping_missing');
  assert.ok(rejectedOpsRow.rejected_count >= 1, 'rejected batch diagnostics should expose rejected_count');
  assert.ok(rejectedOpsRow.rejection_sample_count >= 1, 'rejected batch diagnostics should expose rejection sample count');
  assert.ok(Array.isArray(rejectedOpsRow.rejection_samples), 'rejected batch diagnostics should expose rejection samples');

  const syncAfterMissing = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/device-sync-states?company_id=${encodeURIComponent(companyId)}&agent_id=${encodeURIComponent(bootstrapRes.body.agent_id)}&device_uid=${encodeURIComponent(deviceUid)}`,
    headers
  });
  assert.strictEqual(syncAfterMissing.status, 200, 'sync state listing after missing mapping should return 200');
  assert.ok(Array.isArray(syncAfterMissing.body.value), 'sync state listing after missing mapping should return array');
  assert.ok(syncAfterMissing.body.value.length >= 1, 'sync state listing after missing mapping should include row');
  const missingSyncRow = syncAfterMissing.body.value[0];
  assert.ok(missingSyncRow, 'sync row after missing mapping should exist');
  assert.strictEqual(missingSyncRow.status, 'error', 'missing-mapping rejection should set sync status error');
  assert.strictEqual(missingSyncRow.failure_reason, 'identity_mapping_missing', 'sync failure reason should expose mapping issue');
  assert.strictEqual(
    missingSyncRow.cursor_event_time_utc,
    null,
    'missing-mapping rejection must not advance cursor_event_time_utc'
  );

  const addMissingMapping = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings?company_id=${encodeURIComponent(companyId)}`,
    headers,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      identifier_type: 'pin',
      identifier_value: missingPin,
      person_id: personId,
      active: true
    }
  });
  assert.strictEqual(addMissingMapping.status, 200, 'adding missing mapping should return 200');

  const queueMappedRetryRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(bootstrapRes.body.agent_id)}/commands/pull-device-events`,
    headers,
    body: {
      company_id: companyId,
      device_uid: deviceUid,
      options: {
        host: '192.168.10.20',
        lookback_minutes: 1440,
        safety_window_minutes: 5,
        max_events: 200,
        device_timezone: 'Africa/Tunis'
      }
    }
  });
  assert.strictEqual(queueMappedRetryRes.status, 201, 'retry queue after mapping add should return 201');

  const nextMappedRetryCommandRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: agentAuthHeader,
    body: {}
  });
  assert.strictEqual(nextMappedRetryCommandRes.status, 200, 'retry poll after mapping add should return 200');
  assert.ok(nextMappedRetryCommandRes.body.command, 'agent should receive retry command after mapping add');

  const mappedRetryBatch = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/device-events/batch`,
    headers: agentAuthHeader,
    body: {
      command_id: nextMappedRetryCommandRes.body.command.id,
      run_id: `run-mapped-${runId}`,
      device_uid: deviceUid,
      vendor: 'zkteco',
      ingest_method: 'agent_pull',
      device_timezone: 'Africa/Tunis',
      pull_started_at: '2026-03-06T10:07:00Z',
      pull_completed_at: '2026-03-06T10:08:00Z',
      cursor: {
        requested_since_utc: '2026-03-06T09:00:00Z',
        latest_event_time_utc: missingEventTimeUtc,
        has_more: false
      },
      summary: {
        pull_ok: true
      },
      events: [
        {
          device_person_id: missingPin,
          event_time_local: '2026-03-06 11:05:00',
          event_time_utc: missingEventTimeUtc,
          direction: 'IN',
          raw: {
            source: 'contract_retry_after_mapping'
          }
        }
      ]
    }
  });
  assert.strictEqual(mappedRetryBatch.status, 201, 'mapped retry batch should return 201');
  assert.strictEqual(mappedRetryBatch.body.batch_status, 'accepted', 'mapped retry batch should be accepted');
  assert.strictEqual(mappedRetryBatch.body.inserted_count, 1, 'mapped retry batch should insert previously blocked fact');

  const acceptedOpsBatches = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/device-event-batches?company_id=${encodeURIComponent(companyId)}&agent_id=${encodeURIComponent(bootstrapRes.body.agent_id)}&device_uid=${encodeURIComponent(deviceUid)}&status=accepted`,
    headers
  });
  assert.strictEqual(acceptedOpsBatches.status, 200, 'ops batch diagnostics for accepted status should return 200');
  assert.ok(Array.isArray(acceptedOpsBatches.body.value), 'accepted diagnostics should return value array');
  const acceptedOpsRow = acceptedOpsBatches.body.value.find(
    row => row && row.command_id === nextMappedRetryCommandRes.body.command.id
  );
  assert.ok(acceptedOpsRow, 'successful retry should be visible in batch diagnostics');
  assert.ok(acceptedOpsRow.inserted_count >= 1, 'accepted batch diagnostics should expose inserted evidence');

  const syncAfterMappedRetry = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/device-sync-states?company_id=${encodeURIComponent(companyId)}&agent_id=${encodeURIComponent(bootstrapRes.body.agent_id)}&device_uid=${encodeURIComponent(deviceUid)}`,
    headers
  });
  assert.strictEqual(syncAfterMappedRetry.status, 200, 'sync state listing after mapped retry should return 200');
  assert.ok(Array.isArray(syncAfterMappedRetry.body.value), 'sync state listing after mapped retry should return array');
  assert.ok(syncAfterMappedRetry.body.value.length >= 1, 'sync state listing after mapped retry should include row');
  const mappedRetrySyncRow = syncAfterMappedRetry.body.value[0];
  assert.ok(mappedRetrySyncRow, 'sync row after mapped retry should exist');
  assert.strictEqual(
    mappedRetrySyncRow.cursor_event_time_utc,
    '2026-03-06T10:05:00.000Z',
    'successful mapped retry should advance cursor to accepted fact time'
  );

  const crossPathJson = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/device-events`,
    headers,
    body: {
      company_id: companyId,
      person_id: 'UNTRUSTED_INPUT',
      event_time_utc: missingEventTimeUtc,
      direction: 'IN',
      device_uid: deviceUid,
      vendor: 'zkteco',
      provider: 'zkteco',
      identifier_type: 'pin',
      identifier_value: missingPin
    }
  });
  assert.strictEqual(crossPathJson.status, 200, 'cross-path JSON replay should dedup against existing fact');
  assert.strictEqual(crossPathJson.body.status, 'ok');
  assert.strictEqual(crossPathJson.body.dedup, true, 'cross-path JSON replay should return dedup=true');

  const crossPathCsv = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/device-events/import/commit?company_id=${encodeURIComponent(companyId)}`,
    headers: {
      ...headers,
      'x-vendor': 'zkteco',
      'content-type': 'text/plain'
    },
    body: `badgenumber,checktime,checktype,sn\n${missingPin},2026-03-06 11:05:00,I,sn:${deviceSerial}\n`
  });
  assert.strictEqual(crossPathCsv.status, 200, 'cross-path CSV replay should return 200');
  assert.strictEqual(crossPathCsv.body.inserted_rows, 0, 'cross-path CSV replay should not insert duplicate fact');
  assert.ok(crossPathCsv.body.skipped_rows >= 1, 'cross-path CSV replay should skip duplicate fact');

  const queueReplayRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(bootstrapRes.body.agent_id)}/commands/pull-device-events`,
    headers,
    body: {
      company_id: companyId,
      device_uid: deviceUid,
      options: {
        host: '192.168.10.20',
        lookback_minutes: 1440,
        safety_window_minutes: 5,
        max_events: 200,
        device_timezone: 'Africa/Tunis'
      }
    }
  });
  assert.strictEqual(queueReplayRes.status, 201, 'replay proof queue should return 201');

  const nextReplayCommandRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: agentAuthHeader,
    body: {}
  });
  assert.strictEqual(nextReplayCommandRes.status, 200, 'replay proof poll should return 200');
  assert.ok(nextReplayCommandRes.body.command, 'agent should receive replay proof command');

  const eventTimeUtc = '2026-03-06T10:10:00Z';
  const batchBody = {
    command_id: nextReplayCommandRes.body.command.id,
    run_id: `run-${runId}`,
    device_uid: deviceUid,
    vendor: 'zkteco',
    ingest_method: 'agent_pull',
    device_timezone: 'Africa/Tunis',
    pull_started_at: '2026-03-06T10:09:00Z',
    pull_completed_at: '2026-03-06T10:11:00Z',
    cursor: {
      requested_since_utc: '2026-03-06T09:00:00Z',
      latest_event_time_utc: eventTimeUtc,
      has_more: false
    },
    summary: {
      pull_ok: true
    },
    events: [
      {
        device_person_id: `PIN-${runId}`,
        event_time_local: '2026-03-06 11:10:00',
        event_time_utc: eventTimeUtc,
        direction: 'IN',
        raw: {
          source: 'contract_test'
        }
      }
    ]
  };

  const submitFirst = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/device-events/batch`,
    headers: agentAuthHeader,
    body: batchBody
  });
  assert.strictEqual(submitFirst.status, 201, 'first event batch submit should return 201');
  assert.strictEqual(submitFirst.body.inserted_count, 1, 'first submit should insert one row');
  assert.strictEqual(submitFirst.body.deduped_count, 0, 'first submit should not dedup');

  const submitSecond = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/device-events/batch`,
    headers: agentAuthHeader,
    body: batchBody
  });
  assert.strictEqual(submitSecond.status, 201, 'second event batch submit should return 201');
  assert.strictEqual(submitSecond.body.inserted_count, 0, 'second submit should be deduped');
  assert.ok(submitSecond.body.deduped_count >= 1, 'second submit should report deduped rows');

  const recoveredDevice = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices/${encodeURIComponent(deviceUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers
  });
  assert.strictEqual(recoveredDevice.status, 200, 'device read after retry should return 200');
  assert.strictEqual(recoveredDevice.body.manageability_status, 'ingesting', 'successful retry with accepted evidence should move to ingesting');
  assert.strictEqual(recoveredDevice.body.manageability_reason, 'ingestion_accepted', 'successful retry should expose ingestion reason');
  assert.ok(
    recoveredDevice.body.manageability && recoveredDevice.body.manageability.effective_status === 'ingesting',
    'normalized manageability view should reflect ingesting'
  );

  const ingestingOpsDevices = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices?company_id=${encodeURIComponent(companyId)}&device_uid=${encodeURIComponent(deviceUid)}&manageability_status=ingesting`,
    headers
  });
  assert.strictEqual(ingestingOpsDevices.status, 200, 'ops devices ingesting filter should return 200');
  assert.ok(
    Array.isArray(ingestingOpsDevices.body.value)
      && ingestingOpsDevices.body.value.some(row => row && row.device_uid === deviceUid),
    'ingesting progression should be visible on /api/devices manageability filter'
  );

  const syncStates = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/device-sync-states?company_id=${encodeURIComponent(companyId)}&agent_id=${encodeURIComponent(bootstrapRes.body.agent_id)}&device_uid=${encodeURIComponent(deviceUid)}`,
    headers
  });
  assert.strictEqual(syncStates.status, 200, 'sync state listing should return 200');
  assert.ok(Array.isArray(syncStates.body.value), 'sync state response should include array');
  assert.ok(syncStates.body.value.length >= 1, 'sync state should contain at least one row');

  const crossTenant = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/device-sync-states?company_id=OTHER&agent_id=${encodeURIComponent(bootstrapRes.body.agent_id)}&device_uid=${encodeURIComponent(deviceUid)}`,
    headers
  });
  const expectedCrossTenant = requireAuth() ? 403 : 200;
  assert.strictEqual(crossTenant.status, expectedCrossTenant, 'sync state endpoint tenant scope should match auth mode');

  console.log('agent bridge event ingestion contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
