const assert = require('assert');

const {
  defaultGlobalPolicy,
  getEffectiveAgentVersionPolicy,
  upsertCompanyAgentVersionPolicy,
  extractVersionReportFromHeartbeatPayload,
  upsertAgentRuntimeVersionReportedState
} = require('../../services/versionGovernanceDb');

function createDbMock(handler) {
  return {
    query: async (sql, params) => handler(String(sql), Array.isArray(params) ? params : [])
  };
}

async function runDefaultPolicyFallbackCase() {
  const db = createDbMock((sql) => {
    if (sql.includes('FROM agent_version_governance_policies')) {
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
  });

  const policy = await getEffectiveAgentVersionPolicy(db, { companyId: 'DEFAULT' });
  assert.ok(policy, 'policy result should exist');
  assert.strictEqual(policy.effective_policy.minimum_supported_version, defaultGlobalPolicy().minimum_supported_version);
  assert.strictEqual(policy.effective_policy.policy_source, 'global');
}

async function runCompanyOverridePrecedenceCase() {
  const db = createDbMock((sql) => {
    if (sql.includes('FROM agent_version_governance_policies')) {
      return {
        rows: [
          {
            policy_scope: 'company',
            company_id: 'DEFAULT',
            minimum_supported_version: '1.2.3',
            target_version: '1.4.0',
            rollout_channel: 'stable',
            metadata: {},
            updated_by_key_id: 'ak_test',
            created_at: '2026-03-23T10:00:00.000Z',
            updated_at: '2026-03-23T10:01:00.000Z'
          },
          {
            policy_scope: 'global',
            company_id: null,
            minimum_supported_version: '1.0.0',
            target_version: null,
            rollout_channel: 'stable',
            metadata: {},
            updated_by_key_id: null,
            created_at: '2026-03-23T09:00:00.000Z',
            updated_at: '2026-03-23T09:00:00.000Z'
          }
        ]
      };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
  });

  const policy = await getEffectiveAgentVersionPolicy(db, { companyId: 'DEFAULT' });
  assert.strictEqual(policy.effective_policy.minimum_supported_version, '1.2.3');
  assert.strictEqual(policy.effective_policy.policy_source, 'company_override');
}

async function runPolicyUpsertCase() {
  let captured = null;
  const db = createDbMock((sql, params) => {
    if (sql.includes('INSERT INTO agent_version_governance_policies')) {
      captured = params.slice();
      return {
        rows: [{
          policy_scope: 'company',
          company_id: params[0],
          minimum_supported_version: params[1],
          target_version: params[2],
          rollout_channel: params[3],
          metadata: JSON.parse(params[4]),
          updated_by_key_id: params[5],
          created_at: '2026-03-23T10:00:00.000Z',
          updated_at: '2026-03-23T10:00:00.000Z'
        }]
      };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
  });

  const row = await upsertCompanyAgentVersionPolicy(db, {
    companyId: 'DEFAULT',
    minimumSupportedVersion: '1.2.3',
    targetVersion: '1.4.0',
    rolloutChannel: 'stable',
    metadata: { source: 'test' },
    updatedByKeyId: 'ak_test'
  });

  assert.ok(row, 'upsert should return row');
  assert.strictEqual(captured[0], 'DEFAULT');
  assert.strictEqual(captured[1], '1.2.3');
  assert.strictEqual(captured[2], '1.4.0');
  assert.strictEqual(captured[3], 'stable');
}

function runHeartbeatExtractionCase() {
  const direct = extractVersionReportFromHeartbeatPayload({
    agent_version: '1.5.0',
    rollout_channel: 'beta'
  });
  assert.strictEqual(direct.reported_version, '1.5.0');
  assert.strictEqual(direct.rollout_channel, 'beta');

  const fallback = extractVersionReportFromHeartbeatPayload({
    version: '2.0.1'
  });
  assert.strictEqual(fallback.reported_version, '2.0.1');
  assert.strictEqual(fallback.rollout_channel, null);

  const empty = extractVersionReportFromHeartbeatPayload({});
  assert.strictEqual(empty.reported_version, null);
}

async function runRuntimeVersionUpsertCase() {
  let captured = null;
  const db = createDbMock((sql, params) => {
    if (sql.includes('INSERT INTO agent_runtime_version_reported_state')) {
      captured = params.slice();
      return {
        rows: [{
          company_id: params[0],
          agent_id: params[1],
          site_id: params[2],
          reported_version: params[3],
          rollout_channel: params[4],
          reported_at: params[5],
          metadata: JSON.parse(params[6]),
          created_at: params[5],
          updated_at: params[5]
        }]
      };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
  });

  const row = await upsertAgentRuntimeVersionReportedState(db, {
    companyId: 'DEFAULT',
    agentId: '11111111-1111-4111-8111-111111111111',
    siteId: '22222222-2222-4222-8222-222222222222',
    reportedVersion: '1.2.3',
    rolloutChannel: 'stable',
    reportedAt: '2026-03-23T10:00:00.000Z',
    metadata: { source: 'test' }
  });

  assert.ok(row, 'upsert should return row');
  assert.strictEqual(captured[0], 'DEFAULT');
  assert.strictEqual(captured[3], '1.2.3');
}

async function run() {
  await runDefaultPolicyFallbackCase();
  await runCompanyOverridePrecedenceCase();
  await runPolicyUpsertCase();
  runHeartbeatExtractionCase();
  await runRuntimeVersionUpsertCase();
  console.log('versionGovernanceDb service tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
