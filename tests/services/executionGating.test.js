const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
delete process.env.EXECUTION_GATE_BLOCK_UNKNOWN_CAPABILITY;
delete process.env.EXECUTION_GATE_BLOCK_UNKNOWN_VERSION;
delete process.env.EXECUTION_GATE_BLOCK_OUTDATED_VERSION;
delete process.env.EXECUTION_GATE_POLICY_PROFILE;
delete process.env.EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT;

const {
  EXECUTION_GATE_REASON_CODES,
  evaluateCommandIssuanceGate,
  evaluateCommandAcceptanceGate
} = require('../../services/executionGating');

function createGateDbMock(state = {}) {
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (text.includes('FROM site_agent_leases') && text.includes("status = 'active'")) {
        const activeLease = state.activeLease || null;
        if (!activeLease) {
          return { rows: [] };
        }
        const companyId = params[0];
        const siteId = params[1];
        if (activeLease.company_id === companyId && activeLease.site_id === siteId) {
          return {
            rows: [{
              lease_id: activeLease.lease_id || 'lease-1',
              company_id: activeLease.company_id,
              site_id: activeLease.site_id,
              agent_id: activeLease.agent_id,
              status: 'active',
              leased_at: activeLease.leased_at || '2026-03-20T10:00:00.000Z'
            }]
          };
        }
        return { rows: [] };
      }
      if (text.includes('FROM site_runtime_reported_state')) {
        if (!state.siteReported) {
          return { rows: [] };
        }
        return { rows: [state.siteReported] };
      }
      if (text.includes('FROM agent_runtime_version_reported_state')) {
        if (!state.versionReported) {
          return { rows: [] };
        }
        return { rows: [state.versionReported] };
      }
      if (text.includes('FROM agent_runtime_capability_reported_state')) {
        const companyId = params[0];
        const agentId = params[1];
        const capabilityKey = params[2];
        const rows = Array.isArray(state.runtimeCapabilities) ? state.runtimeCapabilities : [];
        const match = rows.find(row =>
          row.company_id === companyId
          && row.agent_id === agentId
          && row.capability_key === capabilityKey
        );
        return { rows: match ? [match] : [] };
      }
      if (text.includes('FROM device_runtime_capability_reported_state')) {
        const companyId = params[0];
        const deviceUid = params[1];
        const capabilityKey = params[2];
        const rows = Array.isArray(state.deviceCapabilities) ? state.deviceCapabilities : [];
        const match = rows.find(row =>
          row.company_id === companyId
          && row.device_uid === deviceUid
          && row.capability_key === capabilityKey
        );
        return { rows: match ? [match] : [] };
      }
      if (text.includes('FROM agent_version_governance_policies')) {
        return { rows: Array.isArray(state.versionPolicies) ? state.versionPolicies : [] };
      }
      throw new Error(`unexpected query in execution gating test: ${text.slice(0, 140)}`);
    }
  };
}

async function runAllowsWhenSiteContextMissingCase() {
  const db = createGateDbMock();
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: null,
    agentSiteId: null,
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, true);
  assert.ok(Array.isArray(gate.details.warnings));
  assert.ok(gate.details.warnings.includes('site_context_missing_for_pull'));
  assert.ok(gate.details.warnings.includes('site_context_missing_for_pull_transitional_allow'));
  assert.strictEqual(gate.details.gate_mode, 'issuance');
  assert.strictEqual(gate.details.policy_profile, 'balanced');
  assert.strictEqual(gate.details.site_context_required_for_pull, true);
  assert.strictEqual(gate.details.site_context_rollout_stage, 'transitional_allow');
  assert.strictEqual(gate.details.site_context_next_action, 'assign_device_or_agent_site_context');
}

async function runBlocksOnMissingSiteContextForPullInStrictProfileCase() {
  const priorProfile = process.env.EXECUTION_GATE_POLICY_PROFILE;
  process.env.EXECUTION_GATE_POLICY_PROFILE = 'strict';
  try {
    const db = createGateDbMock();
    const gate = await evaluateCommandIssuanceGate(db, {
      companyId: 'DEFAULT',
      targetAgentId: 'agent-1',
      commandType: 'PULL_DEVICE_EVENTS',
      deviceUid: 'zkteco:sn:ABC001',
      deviceSiteId: null,
      agentSiteId: null,
      bindingAgentId: 'agent-1'
    });
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.reason_code, EXECUTION_GATE_REASON_CODES.SITE_CONTEXT_MISSING_FOR_PULL);
  } finally {
    if (typeof priorProfile === 'undefined') {
      delete process.env.EXECUTION_GATE_POLICY_PROFILE;
    } else {
      process.env.EXECUTION_GATE_POLICY_PROFILE = priorProfile;
    }
  }
}

async function runBlocksOnMissingSiteContextForPullWhenBalancedOverrideEnabledCase() {
  const priorProfile = process.env.EXECUTION_GATE_POLICY_PROFILE;
  const priorOverride = process.env.EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT;
  process.env.EXECUTION_GATE_POLICY_PROFILE = 'balanced';
  process.env.EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT = 'true';
  try {
    const db = createGateDbMock();
    const gate = await evaluateCommandIssuanceGate(db, {
      companyId: 'DEFAULT',
      targetAgentId: 'agent-1',
      commandType: 'PULL_DEVICE_EVENTS',
      deviceUid: 'zkteco:sn:ABC001',
      deviceSiteId: null,
      agentSiteId: null,
      bindingAgentId: 'agent-1'
    });
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.reason_code, EXECUTION_GATE_REASON_CODES.SITE_CONTEXT_MISSING_FOR_PULL);
    assert.strictEqual(gate.details.policy_profile, 'balanced');
    assert.strictEqual(gate.details.site_context_rollout_stage, 'balanced_enforced');
    assert.strictEqual(gate.details.policy_rollout.balanced_pull_site_context_block, true);
  } finally {
    if (typeof priorProfile === 'undefined') {
      delete process.env.EXECUTION_GATE_POLICY_PROFILE;
    } else {
      process.env.EXECUTION_GATE_POLICY_PROFILE = priorProfile;
    }
    if (typeof priorOverride === 'undefined') {
      delete process.env.EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT;
    } else {
      process.env.EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT = priorOverride;
    }
  }
}

async function runKeepsCompatTransitionalWhenBalancedOverrideEnabledCase() {
  const priorProfile = process.env.EXECUTION_GATE_POLICY_PROFILE;
  const priorOverride = process.env.EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT;
  process.env.EXECUTION_GATE_POLICY_PROFILE = 'compat';
  process.env.EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT = 'true';
  try {
    const db = createGateDbMock();
    const gate = await evaluateCommandIssuanceGate(db, {
      companyId: 'DEFAULT',
      targetAgentId: 'agent-1',
      commandType: 'PULL_DEVICE_EVENTS',
      deviceUid: 'zkteco:sn:ABC001',
      deviceSiteId: null,
      agentSiteId: null,
      bindingAgentId: 'agent-1'
    });
    assert.strictEqual(gate.allowed, true);
    assert.strictEqual(gate.details.policy_profile, 'compat');
    assert.strictEqual(gate.details.site_context_rollout_stage, 'transitional_allow');
    assert.ok(gate.details.warnings.includes('site_context_missing_for_pull'));
  } finally {
    if (typeof priorProfile === 'undefined') {
      delete process.env.EXECUTION_GATE_POLICY_PROFILE;
    } else {
      process.env.EXECUTION_GATE_POLICY_PROFILE = priorProfile;
    }
    if (typeof priorOverride === 'undefined') {
      delete process.env.EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT;
    } else {
      process.env.EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT = priorOverride;
    }
  }
}

async function runBlocksOnSiteLeaseMismatchCase() {
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-9'
    }
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, false);
  assert.strictEqual(gate.reason_code, EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISMATCH);
  assert.strictEqual(gate.details.active_site_agent_id, 'agent-9');
}

async function runBlocksOnBindingVsLeaseConflictCase() {
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    }
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-8'
  });
  assert.strictEqual(gate.allowed, false);
  assert.strictEqual(gate.reason_code, EXECUTION_GATE_REASON_CODES.DEVICE_BINDING_SITE_RUNTIME_CONFLICT);
}

async function runBlocksOnMissingActiveLeaseForPullCase() {
  const db = createGateDbMock();
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, false);
  assert.strictEqual(gate.reason_code, EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISSING);
}

async function runBlocksOnStaleReportedStateCase() {
  const staleAt = new Date(Date.now() - (60 * 60 * 1000)).toISOString();
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    },
    siteReported: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      reporting_agent_id: 'agent-1',
      runtime_health_status: 'healthy',
      runtime_health_reason: 'command_poll_ok',
      reported_at: staleAt
    }
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, false);
  assert.strictEqual(gate.reason_code, EXECUTION_GATE_REASON_CODES.RUNTIME_REPORTED_STATE_STALE);
}

async function runBlocksOnMissingSiteReportedStateForPullCase() {
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    }
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, false);
  assert.strictEqual(gate.reason_code, EXECUTION_GATE_REASON_CODES.RUNTIME_REPORTED_STATE_MISSING);
}

async function runWarnsOnMissingSiteReportedStateForValidationCase() {
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    }
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'VALIDATE_DEVICE_CANDIDATE',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, true);
  assert.ok(gate.details.warnings.includes('site_runtime_reported_state_missing'));
}

async function runBlocksOnUnsupportedVersionCase() {
  const nowIso = new Date().toISOString();
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    },
    siteReported: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      reporting_agent_id: 'agent-1',
      runtime_health_status: 'healthy',
      runtime_health_reason: 'command_poll_ok',
      reported_at: nowIso
    },
    versionReported: {
      company_id: 'DEFAULT',
      agent_id: 'agent-1',
      reported_version: '1.0.0',
      reported_at: nowIso
    },
    versionPolicies: [{
      policy_scope: 'global',
      company_id: null,
      minimum_supported_version: '2.0.0',
      target_version: null,
      rollout_channel: 'stable',
      metadata: {},
      updated_by_key_id: null,
      created_at: nowIso,
      updated_at: nowIso
    }]
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, false);
  assert.strictEqual(gate.reason_code, EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_UNSUPPORTED);
  assert.strictEqual(gate.details.version_support_status, 'unsupported');
}

async function runAcceptanceLegacyWarningCase() {
  const db = createGateDbMock();
  const gate = await evaluateCommandAcceptanceGate(db, {
    companyId: 'DEFAULT',
    polledAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    commandPayload: {
      device_uid: 'zkteco:sn:ABC001'
    }
  });
  assert.strictEqual(gate.allowed, true);
  assert.ok(gate.details.warnings.includes('site_context_missing'));
  assert.ok(gate.details.warnings.includes('legacy_command_without_site_context'));
}

async function runBlocksOnRuntimeCapabilityUnsupportedCase() {
  const nowIso = new Date().toISOString();
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    },
    siteReported: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      reporting_agent_id: 'agent-1',
      runtime_health_status: 'healthy',
      runtime_health_reason: 'command_poll_ok',
      reported_at: nowIso
    },
    versionReported: {
      company_id: 'DEFAULT',
      agent_id: 'agent-1',
      reported_version: '2.2.0',
      reported_at: nowIso
    },
    versionPolicies: [{
      policy_scope: 'global',
      company_id: null,
      minimum_supported_version: '2.0.0',
      target_version: null,
      rollout_channel: 'stable',
      metadata: {},
      updated_by_key_id: null,
      created_at: nowIso,
      updated_at: nowIso
    }],
    runtimeCapabilities: [{
      company_id: 'DEFAULT',
      agent_id: 'agent-1',
      capability_key: 'command.pull_device_events',
      capability_status: 'unsupported',
      capability_reason: 'runtime_missing_driver',
      reported_at: nowIso
    }]
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, false);
  assert.strictEqual(gate.reason_code, EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_UNSUPPORTED);
  assert.strictEqual(gate.details.runtime_capability_status, 'unsupported');
}

async function runBlocksOnDeviceCapabilityDisabledCase() {
  const nowIso = new Date().toISOString();
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    },
    siteReported: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      reporting_agent_id: 'agent-1',
      runtime_health_status: 'healthy',
      runtime_health_reason: 'command_poll_ok',
      reported_at: nowIso
    },
    versionReported: {
      company_id: 'DEFAULT',
      agent_id: 'agent-1',
      reported_version: '2.2.0',
      reported_at: nowIso
    },
    versionPolicies: [{
      policy_scope: 'global',
      company_id: null,
      minimum_supported_version: '2.0.0',
      target_version: null,
      rollout_channel: 'stable',
      metadata: {},
      updated_by_key_id: null,
      created_at: nowIso,
      updated_at: nowIso
    }],
    runtimeCapabilities: [{
      company_id: 'DEFAULT',
      agent_id: 'agent-1',
      capability_key: 'command.pull_device_events',
      capability_status: 'supported',
      capability_reason: 'command_acknowledged',
      reported_at: nowIso
    }],
    deviceCapabilities: [{
      company_id: 'DEFAULT',
      device_uid: 'zkteco:sn:ABC001',
      capability_key: 'device_path.pull_device_events',
      capability_status: 'disabled',
      capability_reason: 'policy_disabled',
      reported_at: nowIso
    }]
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, false);
  assert.strictEqual(gate.reason_code, EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_DISABLED);
  assert.strictEqual(gate.details.device_path_capability_status, 'disabled');
}

async function runBlocksOnUnknownCapabilityForPullCase() {
  const nowIso = new Date().toISOString();
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    },
    siteReported: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      reporting_agent_id: 'agent-1',
      runtime_health_status: 'healthy',
      runtime_health_reason: 'command_poll_ok',
      reported_at: nowIso
    },
    versionReported: {
      company_id: 'DEFAULT',
      agent_id: 'agent-1',
      reported_version: '2.2.0',
      reported_at: nowIso
    },
    versionPolicies: [{
      policy_scope: 'global',
      company_id: null,
      minimum_supported_version: '2.0.0',
      target_version: null,
      rollout_channel: 'stable',
      metadata: {},
      updated_by_key_id: null,
      created_at: nowIso,
      updated_at: nowIso
    }]
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, false);
  assert.strictEqual(gate.reason_code, EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_UNKNOWN);
  assert.strictEqual(gate.details.policy_profile, 'balanced');
}

async function runWarnsOnUnknownCapabilityForValidationCase() {
  const nowIso = new Date().toISOString();
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    },
    siteReported: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      reporting_agent_id: 'agent-1',
      runtime_health_status: 'healthy',
      runtime_health_reason: 'command_poll_ok',
      reported_at: nowIso
    },
    versionReported: {
      company_id: 'DEFAULT',
      agent_id: 'agent-1',
      reported_version: '2.2.0',
      reported_at: nowIso
    },
    versionPolicies: [{
      policy_scope: 'global',
      company_id: null,
      minimum_supported_version: '2.0.0',
      target_version: null,
      rollout_channel: 'stable',
      metadata: {},
      updated_by_key_id: null,
      created_at: nowIso,
      updated_at: nowIso
    }]
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'VALIDATE_DEVICE_CANDIDATE',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, true);
  assert.ok(gate.details.warnings.includes('runtime_capability_unknown'));
  assert.ok(gate.details.warnings.includes('device_path_capability_unknown'));
}

async function runBlocksOnMissingVersionForPullCase() {
  const nowIso = new Date().toISOString();
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    },
    siteReported: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      reporting_agent_id: 'agent-1',
      runtime_health_status: 'healthy',
      runtime_health_reason: 'command_poll_ok',
      reported_at: nowIso
    },
    versionPolicies: [{
      policy_scope: 'global',
      company_id: null,
      minimum_supported_version: '2.0.0',
      target_version: null,
      rollout_channel: 'stable',
      metadata: {},
      updated_by_key_id: null,
      created_at: nowIso,
      updated_at: nowIso
    }]
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, false);
  assert.strictEqual(gate.reason_code, EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_UNKNOWN);
}

async function runWarnsOnMissingVersionForValidationCase() {
  const nowIso = new Date().toISOString();
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    },
    siteReported: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      reporting_agent_id: 'agent-1',
      runtime_health_status: 'healthy',
      runtime_health_reason: 'command_poll_ok',
      reported_at: nowIso
    },
    versionPolicies: [{
      policy_scope: 'global',
      company_id: null,
      minimum_supported_version: '2.0.0',
      target_version: null,
      rollout_channel: 'stable',
      metadata: {},
      updated_by_key_id: null,
      created_at: nowIso,
      updated_at: nowIso
    }]
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'VALIDATE_DEVICE_CANDIDATE',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, true);
  assert.strictEqual(gate.details.version_support_status, 'unknown');
  assert.ok(gate.details.warnings.includes('runtime_version_unknown'));
}

async function runWarnsOnOutdatedVersionForPullCase() {
  const nowIso = new Date().toISOString();
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    },
    siteReported: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      reporting_agent_id: 'agent-1',
      runtime_health_status: 'healthy',
      runtime_health_reason: 'command_poll_ok',
      reported_at: nowIso
    },
    versionReported: {
      company_id: 'DEFAULT',
      agent_id: 'agent-1',
      reported_version: '2.1.0',
      reported_at: nowIso
    },
    versionPolicies: [{
      policy_scope: 'global',
      company_id: null,
      minimum_supported_version: '2.0.0',
      target_version: '2.3.0',
      rollout_channel: 'stable',
      metadata: {},
      updated_by_key_id: null,
      created_at: nowIso,
      updated_at: nowIso
    }],
    runtimeCapabilities: [{
      company_id: 'DEFAULT',
      agent_id: 'agent-1',
      capability_key: 'command.pull_device_events',
      capability_status: 'supported',
      capability_reason: 'command_acknowledged',
      reported_at: nowIso
    }],
    deviceCapabilities: [{
      company_id: 'DEFAULT',
      device_uid: 'zkteco:sn:ABC001',
      capability_key: 'device_path.pull_device_events',
      capability_status: 'supported',
      capability_reason: 'validation_succeeded',
      reported_at: nowIso
    }]
  });
  const gate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(gate.allowed, true);
  assert.strictEqual(gate.details.version_support_status, 'outdated');
  assert.ok(gate.details.warnings.includes('runtime_version_outdated'));
}

async function runRefreshPullCapabilityDoesNotRequireDevicePathCapabilityCase() {
  const nowIso = new Date().toISOString();
  const staleIso = '2026-03-23T08:30:28.039Z';
  const db = createGateDbMock({
    activeLease: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-1'
    },
    siteReported: {
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      reporting_agent_id: 'agent-1',
      runtime_health_status: 'healthy',
      runtime_health_reason: 'heartbeat_ok',
      reported_at: nowIso,
      last_heartbeat_at: nowIso,
      last_poll_at: nowIso
    },
    versionReported: {
      company_id: 'DEFAULT',
      agent_id: 'agent-1',
      reported_version: '1.4.0',
      reported_at: nowIso
    },
    runtimeCapabilities: [{
      company_id: 'DEFAULT',
      agent_id: 'agent-1',
      capability_key: 'command.pull_device_events',
      capability_status: 'supported',
      capability_reason: 'heartbeat',
      reported_at: nowIso
    }],
    deviceCapabilities: [{
      company_id: 'DEFAULT',
      device_uid: 'zkteco:sn:ABC001',
      capability_key: 'device_path.pull_device_events',
      capability_status: 'supported',
      capability_reason: 'pull_succeeded',
      reported_at: staleIso
    }]
  });

  const refreshGate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'REFRESH_DEVICE_PATH_PULL_CAPABILITY',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(refreshGate.allowed, true);
  assert.strictEqual(refreshGate.details.required_runtime_capability_key, 'command.pull_device_events');
  assert.strictEqual(refreshGate.details.required_device_capability_key, null);

  const pullGate = await evaluateCommandIssuanceGate(db, {
    companyId: 'DEFAULT',
    targetAgentId: 'agent-1',
    commandType: 'PULL_DEVICE_EVENTS',
    deviceUid: 'zkteco:sn:ABC001',
    deviceSiteId: '11111111-1111-1111-1111-111111111111',
    agentSiteId: '11111111-1111-1111-1111-111111111111',
    bindingAgentId: 'agent-1'
  });
  assert.strictEqual(pullGate.allowed, false);
  assert.strictEqual(pullGate.reason_code, EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_UNKNOWN);
  assert.strictEqual(pullGate.details.device_path_capability_reason, 'reported_state_stale');
}

async function run() {
  await runAllowsWhenSiteContextMissingCase();
  await runBlocksOnMissingSiteContextForPullInStrictProfileCase();
  await runBlocksOnMissingSiteContextForPullWhenBalancedOverrideEnabledCase();
  await runKeepsCompatTransitionalWhenBalancedOverrideEnabledCase();
  await runBlocksOnSiteLeaseMismatchCase();
  await runBlocksOnBindingVsLeaseConflictCase();
  await runBlocksOnMissingActiveLeaseForPullCase();
  await runBlocksOnStaleReportedStateCase();
  await runBlocksOnMissingSiteReportedStateForPullCase();
  await runWarnsOnMissingSiteReportedStateForValidationCase();
  await runBlocksOnUnsupportedVersionCase();
  await runAcceptanceLegacyWarningCase();
  await runBlocksOnRuntimeCapabilityUnsupportedCase();
  await runBlocksOnDeviceCapabilityDisabledCase();
  await runBlocksOnUnknownCapabilityForPullCase();
  await runWarnsOnUnknownCapabilityForValidationCase();
  await runBlocksOnMissingVersionForPullCase();
  await runWarnsOnMissingVersionForValidationCase();
  await runWarnsOnOutdatedVersionForPullCase();
  await runRefreshPullCapabilityDoesNotRequireDevicePathCapabilityCase();
  console.log('execution gating service tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
