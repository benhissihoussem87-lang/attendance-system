const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const policiesPath = path.join(__dirname, '..', '..', 'public', 'app', 'policies.js');
let source = fs.readFileSync(policiesPath, 'utf8');
source = source
  .replace(/^import[^;]+;\r?\n/gm, '')
  .replace(/export function /g, 'function ')
  .replace(/export const /g, 'const ')
  .replace(/export \{[^}]+\};?/g, '');

const sandbox = {
  Intl,
  Date,
  Number,
  RegExp,
  text(value) { return value == null ? '' : String(value); },
  activeCompanyId() { return 'DEFAULT'; },
  knownAgentId: 'agent-test',
  state: { sites: [], companies: [] }
};
vm.createContext(sandbox);
vm.runInContext(`${source}
this.productSafeErrorLabel = productSafeErrorLabel;
this.attendanceStatusDisplayLabel = attendanceStatusDisplayLabel;
this.attendanceExplanationDisplayLabel = attendanceExplanationDisplayLabel;
this.getRtRowSavedAt = getRtRowSavedAt;
this.isRtRowInCurrentSession = isRtRowInCurrentSession;
this.liveSessionState = liveSessionState;
this.rtPersistenceHealthSummary = rtPersistenceHealthSummary;`, sandbox);

assert.strictEqual(
  sandbox.productSafeErrorLabel(new Error('runtime_reported_state_stale')),
  'Agent status is stale. Waiting for a fresh agent heartbeat.'
);
assert.strictEqual(
  sandbox.productSafeErrorLabel(new Error('runtime_capability_unknown')),
  'Agent capability is not confirmed yet.'
);
assert.strictEqual(
  sandbox.productSafeErrorLabel(new Error('device_path_capability_unknown')),
  'Device sync capability needs a fresh readiness check.'
);
assert.strictEqual(
  sandbox.productSafeErrorLabel(new Error('missing_or_invalid_session')),
  'Session expired. Please sign in again.'
);
assert.strictEqual(sandbox.attendanceStatusDisplayLabel('complete_day'), 'Complete day');
assert.strictEqual(sandbox.attendanceStatusDisplayLabel('invalid'), 'Needs review');
assert.strictEqual(sandbox.attendanceStatusDisplayLabel('incomplete'), 'Needs review');
assert.strictEqual(sandbox.attendanceExplanationDisplayLabel('non-alternating IN/OUT sequence'), 'Punch sequence issue');
assert.strictEqual(sandbox.attendanceExplanationDisplayLabel('late calculation not configured'), 'Schedule rules not configured');

const activeSession = {
  status: 'active',
  started_at: '2026-05-08T10:58:20.594Z',
  expires_at: '2026-05-08T11:58:20.594Z',
  active_lease: true
};
const oldRtRow = {
  id: 'old-row',
  created_at: '2026-05-07T11:24:56.400Z',
  source_metadata: {
    rt_time_contract_version: 'dual_time_v1',
    rt_time_observed_trust: 'untrusted',
    rt_time_chronology_source: 'server_ingest_clock',
    rt_time_chronology_utc: '2026-05-07T11:24:56.478Z'
  }
};
const currentRtRow = {
  id: 'current-row',
  created_at: '2026-05-08T10:59:00.000Z',
  source_metadata: {
    rt_time_contract_version: 'dual_time_v1',
    rt_time_observed_trust: 'untrusted',
    rt_time_chronology_source: 'server_ingest_clock',
    rt_time_chronology_utc: '2002-02-23T23:04:21.000Z'
  }
};

assert.strictEqual(sandbox.getRtRowSavedAt(oldRtRow), '2026-05-07T11:24:56.400Z');
assert.strictEqual(sandbox.isRtRowInCurrentSession(oldRtRow, activeSession), false);
assert.strictEqual(sandbox.liveSessionState([oldRtRow], activeSession).hasCurrentSessionProof, false);
assert.strictEqual(sandbox.liveSessionState([oldRtRow], activeSession).label, 'Old live punches only');
assert.strictEqual(sandbox.isRtRowInCurrentSession(currentRtRow, activeSession), true);
assert.strictEqual(sandbox.liveSessionState([currentRtRow, oldRtRow], activeSession).hasCurrentSessionProof, true);
assert.strictEqual(sandbox.liveSessionState([currentRtRow, oldRtRow], activeSession).label, 'Live punch saved in current session');

const disabledPersistence = sandbox.rtPersistenceHealthSummary({
  rt_diagnostics_summary: {
    ingest_method: 'agent_realtime',
    events_received_count: 1,
    inserted_count: 0,
    k80_rt_ingest_policy_enabled: false,
    k80_rt_ingest_insert_path_skipped: true,
    k80_rt_ingest_insert_path_skip_reason: 'k80_rt_ingest_policy_disabled'
  }
});
assert.strictEqual(disabledPersistence.label, 'Live capture received, persistence disabled');

console.log('PASS: product surface smoke labels');
