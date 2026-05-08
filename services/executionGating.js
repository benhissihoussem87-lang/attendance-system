const { normalizeText } = require('./agentAuth');
const {
  defaultSiteRuntimeReportedStaleMinutes,
  defaultRuntimeCapabilityReportedStaleMinutes,
  defaultDeviceCapabilityReportedStaleMinutes,
  toSiteRuntimeReportedReadModel,
  toCapabilityReportedReadModel,
  getSiteRuntimeReportedState,
  getAgentRuntimeCapabilityReportedState,
  getDeviceRuntimeCapabilityReportedState
} = require('./reportedStateDb');
const {
  defaultAgentVersionReportedStaleMinutes,
  evaluateAgentVersionSupport
} = require('./versionGovernance');
const {
  getEffectiveAgentVersionPolicy,
  getAgentRuntimeVersionReportedState
} = require('./versionGovernanceDb');
const {
  CAPABILITY_STATUS,
  resolveCommandCapabilityRequirements
} = require('../contracts/capabilityContract');

const EXECUTION_GATE_REASON_CODES = Object.freeze({
  SITE_CONTEXT_MISSING_FOR_PULL: 'site_context_missing_for_pull',
  SITE_ACTIVE_RUNTIME_MISMATCH: 'site_active_runtime_mismatch',
  SITE_ACTIVE_RUNTIME_MISSING: 'site_active_runtime_missing',
  DEVICE_BINDING_SITE_RUNTIME_CONFLICT: 'device_binding_site_runtime_conflict',
  RUNTIME_REPORTED_STATE_MISSING: 'runtime_reported_state_missing',
  RUNTIME_REPORTED_STATE_STALE: 'runtime_reported_state_stale',
  RUNTIME_HEALTH_OFFLINE: 'runtime_health_offline',
  RUNTIME_HEALTH_BLOCKED: 'runtime_health_blocked',
  RUNTIME_HEALTH_UNKNOWN: 'runtime_health_unknown',
  RUNTIME_VERSION_UNSUPPORTED: 'runtime_version_unsupported',
  RUNTIME_VERSION_UNKNOWN: 'runtime_version_unknown',
  RUNTIME_VERSION_OUTDATED: 'runtime_version_outdated',
  RUNTIME_CAPABILITY_UNSUPPORTED: 'runtime_capability_unsupported',
  RUNTIME_CAPABILITY_DISABLED: 'runtime_capability_disabled',
  RUNTIME_CAPABILITY_UNKNOWN: 'runtime_capability_unknown',
  DEVICE_PATH_CAPABILITY_UNSUPPORTED: 'device_path_capability_unsupported',
  DEVICE_PATH_CAPABILITY_DISABLED: 'device_path_capability_disabled',
  DEVICE_PATH_CAPABILITY_UNKNOWN: 'device_path_capability_unknown'
});

const POLICY_LEVELS = Object.freeze({
  ALLOW: 'allow',
  WARN: 'warn',
  BLOCK: 'block'
});

const EXECUTION_POLICY_PROFILES = Object.freeze({
  compat: Object.freeze({
    default: Object.freeze({
      missing_site_context_for_pull: POLICY_LEVELS.WARN,
      missing_active_site_lease: POLICY_LEVELS.WARN,
      missing_site_runtime_report: POLICY_LEVELS.WARN,
      unknown_runtime_version: POLICY_LEVELS.WARN,
      outdated_runtime_version: POLICY_LEVELS.WARN,
      unknown_runtime_capability: POLICY_LEVELS.WARN,
      unknown_device_capability: POLICY_LEVELS.WARN
    })
  }),
  balanced: Object.freeze({
    default: Object.freeze({
      missing_site_context_for_pull: POLICY_LEVELS.WARN,
      missing_active_site_lease: POLICY_LEVELS.BLOCK,
      missing_site_runtime_report: POLICY_LEVELS.BLOCK,
      unknown_runtime_version: POLICY_LEVELS.BLOCK,
      outdated_runtime_version: POLICY_LEVELS.WARN,
      unknown_runtime_capability: POLICY_LEVELS.WARN,
      unknown_device_capability: POLICY_LEVELS.WARN
    }),
    PULL_DEVICE_EVENTS: Object.freeze({
      unknown_runtime_capability: POLICY_LEVELS.BLOCK,
      unknown_device_capability: POLICY_LEVELS.BLOCK
    }),
    VALIDATE_DEVICE_CANDIDATE: Object.freeze({
      missing_site_runtime_report: POLICY_LEVELS.WARN,
      unknown_runtime_version: POLICY_LEVELS.WARN
    })
  }),
  strict: Object.freeze({
    default: Object.freeze({
      missing_site_context_for_pull: POLICY_LEVELS.BLOCK,
      missing_active_site_lease: POLICY_LEVELS.BLOCK,
      missing_site_runtime_report: POLICY_LEVELS.BLOCK,
      unknown_runtime_version: POLICY_LEVELS.BLOCK,
      outdated_runtime_version: POLICY_LEVELS.BLOCK,
      unknown_runtime_capability: POLICY_LEVELS.BLOCK,
      unknown_device_capability: POLICY_LEVELS.BLOCK
    })
  })
});

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUuidLike(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function parseBool(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizePolicyLevel(value, fallback = POLICY_LEVELS.WARN) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === POLICY_LEVELS.ALLOW || normalized === POLICY_LEVELS.WARN || normalized === POLICY_LEVELS.BLOCK) {
    return normalized;
  }
  return fallback;
}

function normalizePolicyProfile(value, fallback = 'balanced') {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (Object.prototype.hasOwnProperty.call(EXECUTION_POLICY_PROFILES, normalized)) {
    return normalized;
  }
  return fallback;
}

function defaultExecutionPolicyProfile() {
  return normalizePolicyProfile(process.env.EXECUTION_GATE_POLICY_PROFILE, 'balanced');
}

function shouldBlockUnknownCapability() {
  return parseBool(process.env.EXECUTION_GATE_BLOCK_UNKNOWN_CAPABILITY, false);
}

function shouldBlockUnknownVersion() {
  return parseBool(process.env.EXECUTION_GATE_BLOCK_UNKNOWN_VERSION, false);
}

function shouldBlockOutdatedVersion() {
  return parseBool(process.env.EXECUTION_GATE_BLOCK_OUTDATED_VERSION, false);
}

function shouldBlockMissingSiteContextForPullInBalancedProfile() {
  return parseBool(process.env.EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT, false);
}

function pushWarning(warnings, warningCode) {
  const safeWarning = normalizeText(warningCode);
  if (!safeWarning) {
    return;
  }
  if (!warnings.includes(safeWarning)) {
    warnings.push(safeWarning);
  }
}

function resolveExecutionPolicyLevels(commandType) {
  const profile = defaultExecutionPolicyProfile();
  const profileConfig = EXECUTION_POLICY_PROFILES[profile] || EXECUTION_POLICY_PROFILES.balanced;
  const normalizedCommandType = normalizeText(commandType).toUpperCase();
  const isPullCommand = normalizedCommandType === 'PULL_DEVICE_EVENTS';
  const balancedPullSiteContextBlockOverride = (
    profile === 'balanced'
    && isPullCommand
    && shouldBlockMissingSiteContextForPullInBalancedProfile()
  );
  const base = profileConfig.default || {};
  const commandOverrides = normalizedCommandType ? (profileConfig[normalizedCommandType] || {}) : {};
  const levels = {
    missing_site_context_for_pull: normalizePolicyLevel(
      commandOverrides.missing_site_context_for_pull,
      normalizePolicyLevel(base.missing_site_context_for_pull, POLICY_LEVELS.WARN)
    ),
    missing_active_site_lease: normalizePolicyLevel(
      commandOverrides.missing_active_site_lease,
      normalizePolicyLevel(base.missing_active_site_lease, POLICY_LEVELS.WARN)
    ),
    missing_site_runtime_report: normalizePolicyLevel(
      commandOverrides.missing_site_runtime_report,
      normalizePolicyLevel(base.missing_site_runtime_report, POLICY_LEVELS.WARN)
    ),
    unknown_runtime_version: normalizePolicyLevel(
      commandOverrides.unknown_runtime_version,
      normalizePolicyLevel(base.unknown_runtime_version, POLICY_LEVELS.WARN)
    ),
    outdated_runtime_version: normalizePolicyLevel(
      commandOverrides.outdated_runtime_version,
      normalizePolicyLevel(base.outdated_runtime_version, POLICY_LEVELS.WARN)
    ),
    unknown_runtime_capability: normalizePolicyLevel(
      commandOverrides.unknown_runtime_capability,
      normalizePolicyLevel(base.unknown_runtime_capability, POLICY_LEVELS.WARN)
    ),
    unknown_device_capability: normalizePolicyLevel(
      commandOverrides.unknown_device_capability,
      normalizePolicyLevel(base.unknown_device_capability, POLICY_LEVELS.WARN)
    )
  };

  if (shouldBlockUnknownCapability()) {
    levels.unknown_runtime_capability = POLICY_LEVELS.BLOCK;
    levels.unknown_device_capability = POLICY_LEVELS.BLOCK;
  }
  if (shouldBlockUnknownVersion()) {
    levels.unknown_runtime_version = POLICY_LEVELS.BLOCK;
  }
  if (shouldBlockOutdatedVersion()) {
    levels.outdated_runtime_version = POLICY_LEVELS.BLOCK;
  }
  if (balancedPullSiteContextBlockOverride) {
    levels.missing_site_context_for_pull = POLICY_LEVELS.BLOCK;
  }

  return {
    profile,
    levels,
    rollout: {
      balanced_pull_site_context_block: balancedPullSiteContextBlockOverride
    }
  };
}

function addPolicyDecision(details, {
  check,
  observedStatus,
  policyLevel,
  reason
}) {
  const decision = {
    check: normalizeText(check) || null,
    observed_status: normalizeText(observedStatus) || null,
    policy_level: normalizePolicyLevel(policyLevel, POLICY_LEVELS.WARN),
    reason: normalizeText(reason) || null
  };
  if (!Array.isArray(details.policy_decisions)) {
    details.policy_decisions = [];
  }
  details.policy_decisions.push(decision);
  return decision;
}

function applyPolicyDecision({
  details,
  warnings,
  check,
  observedStatus,
  policyLevel,
  reason,
  warningCode,
  blockReasonCode
}) {
  const decision = addPolicyDecision(details, {
    check,
    observedStatus,
    policyLevel,
    reason
  });
  if (decision.policy_level === POLICY_LEVELS.BLOCK) {
    return blocked(blockReasonCode, details);
  }
  if (decision.policy_level === POLICY_LEVELS.WARN) {
    pushWarning(warnings, warningCode);
  }
  return null;
}

async function getActiveSiteLease(db, { companyId, siteId }) {
  const safeCompanyId = normalizeText(companyId);
  const safeSiteId = normalizeUuidLike(siteId);
  if (!safeCompanyId || !safeSiteId) {
    return null;
  }
  const res = await db.query(
    `
    SELECT
      lease_id,
      company_id,
      site_id,
      agent_id,
      status,
      leased_at
    FROM site_agent_leases
    WHERE company_id = $1
      AND site_id = $2
      AND status = 'active'
    LIMIT 1
    `,
    [safeCompanyId, safeSiteId]
  );
  return res.rows[0] || null;
}

function resolveEffectiveSiteId({ deviceSiteId, agentSiteId }) {
  const normalizedDeviceSiteId = normalizeUuidLike(deviceSiteId);
  const normalizedAgentSiteId = normalizeUuidLike(agentSiteId);
  if (normalizedDeviceSiteId && normalizedAgentSiteId && normalizedDeviceSiteId !== normalizedAgentSiteId) {
    return {
      conflict: true,
      site_id: normalizedDeviceSiteId,
      device_site_id: normalizedDeviceSiteId,
      agent_site_id: normalizedAgentSiteId
    };
  }
  return {
    conflict: false,
    site_id: normalizedDeviceSiteId || normalizedAgentSiteId || null,
    device_site_id: normalizedDeviceSiteId,
    agent_site_id: normalizedAgentSiteId
  };
}

function blocked(reasonCode, details) {
  return {
    allowed: false,
    reason_code: reasonCode,
    details
  };
}

function allowed(details) {
  return {
    allowed: true,
    reason_code: null,
    details
  };
}

async function evaluateRuntimeExecutionGate(db, {
  companyId,
  targetAgentId,
  commandType,
  deviceUid,
  deviceSiteId,
  agentSiteId,
  bindingAgentId,
  gateMode = 'issuance'
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeTargetAgentId = normalizeUuidLike(targetAgentId);
  const safeCommandType = normalizeText(commandType) || null;
  const safeDeviceUid = normalizeText(deviceUid) || null;
  const safeBindingAgentId = normalizeUuidLike(bindingAgentId);
  const safeGateMode = normalizeText(gateMode).toLowerCase() || 'issuance';
  const warnings = [];
  const executionPolicy = resolveExecutionPolicyLevels(safeCommandType);

  const siteResolution = resolveEffectiveSiteId({
    deviceSiteId,
    agentSiteId
  });
  const details = {
    command_type: safeCommandType,
    target_agent_id: safeTargetAgentId,
    device_uid: safeDeviceUid,
    site_id: siteResolution.site_id,
    device_site_id: siteResolution.device_site_id,
    agent_site_id: siteResolution.agent_site_id,
    active_site_agent_id: null,
    runtime_health_status: null,
    runtime_health_reason: null,
    runtime_reported_at: null,
    runtime_reported_stale: null,
    version_support_status: null,
    version_support_reason: null,
    agent_reported_version: null,
    agent_version_reported_at: null,
    required_runtime_capability_key: null,
    runtime_capability_status: null,
    runtime_capability_reason: null,
    runtime_capability_reported_at: null,
    runtime_capability_reported_stale: null,
    required_device_capability_key: null,
    device_path_capability_status: null,
    device_path_capability_reason: null,
    device_path_capability_reported_at: null,
    device_path_capability_reported_stale: null,
    policy_profile: executionPolicy.profile,
    policy_levels: executionPolicy.levels,
    policy_rollout: executionPolicy.rollout || {},
    gate_mode: safeGateMode,
    policy_decisions: [],
    warnings
  };

  if (siteResolution.conflict) {
    return blocked(EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISMATCH, {
      ...details,
      gate_reason: 'device_site_agent_site_conflict'
    });
  }

  if (!siteResolution.site_id) {
    if (safeCommandType === 'PULL_DEVICE_EVENTS' && safeGateMode === 'issuance') {
      details.site_context_required_for_pull = true;
      details.site_context_requirement = 'formal_site_assignment_required_for_pull';
      details.site_context_next_action = 'assign_device_or_agent_site_context';
      details.site_context_rollout_stage = executionPolicy.rollout
        && executionPolicy.rollout.balanced_pull_site_context_block
        ? 'balanced_enforced'
        : 'transitional_allow';
      const missingSiteContextPullDecision = applyPolicyDecision({
        details,
        warnings,
        check: 'missing_site_context_for_pull',
        observedStatus: 'missing',
        policyLevel: executionPolicy.levels.missing_site_context_for_pull,
        reason: 'site_context_missing_for_pull',
        warningCode: 'site_context_missing_for_pull',
        blockReasonCode: EXECUTION_GATE_REASON_CODES.SITE_CONTEXT_MISSING_FOR_PULL
      });
      if (missingSiteContextPullDecision) {
        return missingSiteContextPullDecision;
      }
      if (executionPolicy.levels.missing_site_context_for_pull === POLICY_LEVELS.WARN) {
        pushWarning(warnings, 'site_context_missing_for_pull_transitional_allow');
      }
      return allowed(details);
    }
    pushWarning(warnings, 'site_context_missing');
    return allowed(details);
  }

  const activeLease = await getActiveSiteLease(db, {
    companyId: safeCompanyId,
    siteId: siteResolution.site_id
  });
  details.active_site_agent_id = normalizeUuidLike(activeLease && activeLease.agent_id);

  if (activeLease && safeTargetAgentId && normalizeUuidLike(activeLease.agent_id) !== safeTargetAgentId) {
    return blocked(EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISMATCH, details);
  }

  if (activeLease && safeBindingAgentId && normalizeUuidLike(activeLease.agent_id) !== safeBindingAgentId) {
    return blocked(EXECUTION_GATE_REASON_CODES.DEVICE_BINDING_SITE_RUNTIME_CONFLICT, {
      ...details,
      bound_agent_id: safeBindingAgentId
    });
  }

  if (!activeLease) {
    const noLeaseDecision = applyPolicyDecision({
      details,
      warnings,
      check: 'missing_active_site_lease',
      observedStatus: 'missing',
      policyLevel: executionPolicy.levels.missing_active_site_lease,
      reason: 'site_active_runtime_missing',
      warningCode: 'site_active_runtime_missing',
      blockReasonCode: EXECUTION_GATE_REASON_CODES.SITE_ACTIVE_RUNTIME_MISSING
    });
    if (noLeaseDecision) {
      return noLeaseDecision;
    }
    return allowed(details);
  }

  const siteReportedRow = await getSiteRuntimeReportedState(db, {
    companyId: safeCompanyId,
    siteId: siteResolution.site_id
  });
  if (!siteReportedRow) {
    details.runtime_health_status = 'unknown';
    details.runtime_health_reason = 'site_runtime_reported_state_missing';
    details.runtime_reported_stale = true;
    const missingSiteReportedDecision = applyPolicyDecision({
      details,
      warnings,
      check: 'missing_site_runtime_report',
      observedStatus: 'missing',
      policyLevel: executionPolicy.levels.missing_site_runtime_report,
      reason: 'site_runtime_reported_state_missing',
      warningCode: 'site_runtime_reported_state_missing',
      blockReasonCode: EXECUTION_GATE_REASON_CODES.RUNTIME_REPORTED_STATE_MISSING
    });
    if (missingSiteReportedDecision) {
      return missingSiteReportedDecision;
    }
  } else {
    const siteReported = toSiteRuntimeReportedReadModel(siteReportedRow, {
      staleMinutes: defaultSiteRuntimeReportedStaleMinutes()
    });
    details.runtime_health_status = siteReported.health_status;
    details.runtime_health_reason = siteReported.health_reason;
    details.runtime_reported_at = siteReported.reported_at;
    details.runtime_reported_stale = siteReported.reported_stale;

    if (siteReported.reported_stale) {
      return blocked(EXECUTION_GATE_REASON_CODES.RUNTIME_REPORTED_STATE_STALE, details);
    }
    if (siteReported.health_status === 'offline') {
      return blocked(EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_OFFLINE, details);
    }
    if (siteReported.health_status === 'blocked') {
      return blocked(EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_BLOCKED, details);
    }
    if (siteReported.health_status === 'unknown') {
      return blocked(EXECUTION_GATE_REASON_CODES.RUNTIME_HEALTH_UNKNOWN, details);
    }
  }

  const policy = await getEffectiveAgentVersionPolicy(db, {
    companyId: safeCompanyId
  });
  const versionRow = await getAgentRuntimeVersionReportedState(db, {
    companyId: safeCompanyId,
    agentId: safeTargetAgentId
  });
  if (!versionRow) {
    pushWarning(warnings, 'agent_version_report_missing');
  }
  const versionSupport = evaluateAgentVersionSupport({
    reportedVersion: versionRow ? versionRow.reported_version : null,
    reportedAt: versionRow ? versionRow.reported_at : null,
    minimumSupportedVersion: policy && policy.effective_policy
      ? policy.effective_policy.minimum_supported_version
      : null,
    targetVersion: policy && policy.effective_policy
      ? policy.effective_policy.target_version
      : null,
    staleMinutes: defaultAgentVersionReportedStaleMinutes()
  });

  details.agent_reported_version = versionSupport.reported_version;
  details.agent_version_reported_at = versionSupport.reported_at;
  details.version_support_status = versionSupport.support_status;
  details.version_support_reason = versionSupport.support_reason;

  if (versionSupport.support_status === 'unsupported') {
    return blocked(EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_UNSUPPORTED, details);
  }
  if (versionSupport.support_status === 'unknown') {
    const unknownVersionDecision = applyPolicyDecision({
      details,
      warnings,
      check: 'unknown_runtime_version',
      observedStatus: 'unknown',
      policyLevel: executionPolicy.levels.unknown_runtime_version,
      reason: versionSupport.support_reason || 'runtime_version_unknown',
      warningCode: 'runtime_version_unknown',
      blockReasonCode: EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_UNKNOWN
    });
    if (unknownVersionDecision) {
      return unknownVersionDecision;
    }
  } else if (versionSupport.support_status === 'outdated') {
    const outdatedVersionDecision = applyPolicyDecision({
      details,
      warnings,
      check: 'outdated_runtime_version',
      observedStatus: 'outdated',
      policyLevel: executionPolicy.levels.outdated_runtime_version,
      reason: versionSupport.support_reason || 'runtime_version_outdated',
      warningCode: 'runtime_version_outdated',
      blockReasonCode: EXECUTION_GATE_REASON_CODES.RUNTIME_VERSION_OUTDATED
    });
    if (outdatedVersionDecision) {
      return outdatedVersionDecision;
    }
  }

  const capabilityRequirements = resolveCommandCapabilityRequirements(safeCommandType);
  if (capabilityRequirements) {
    details.required_runtime_capability_key = capabilityRequirements.runtime_capability_key || null;
    details.required_device_capability_key = capabilityRequirements.device_capability_key || null;

    if (details.required_runtime_capability_key) {
      const runtimeCapabilityRow = await getAgentRuntimeCapabilityReportedState(db, {
        companyId: safeCompanyId,
        agentId: safeTargetAgentId,
        capabilityKey: details.required_runtime_capability_key
      });
      const runtimeCapability = toCapabilityReportedReadModel(runtimeCapabilityRow, {
        staleMinutes: defaultRuntimeCapabilityReportedStaleMinutes()
      });
      details.runtime_capability_status = runtimeCapability.status;
      details.runtime_capability_reason = runtimeCapability.reason;
      details.runtime_capability_reported_at = runtimeCapability.reported_at;
      details.runtime_capability_reported_stale = runtimeCapability.reported_stale;

      if (runtimeCapability.status === CAPABILITY_STATUS.UNSUPPORTED) {
        return blocked(EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_UNSUPPORTED, details);
      }
      if (runtimeCapability.status === CAPABILITY_STATUS.DISABLED) {
        return blocked(EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_DISABLED, details);
      }
      if (runtimeCapability.status === CAPABILITY_STATUS.UNKNOWN) {
        const runtimeCapabilityUnknownDecision = applyPolicyDecision({
          details,
          warnings,
          check: 'unknown_runtime_capability',
          observedStatus: 'unknown',
          policyLevel: executionPolicy.levels.unknown_runtime_capability,
          reason: runtimeCapability.reason || 'runtime_capability_unknown',
          warningCode: 'runtime_capability_unknown',
          blockReasonCode: EXECUTION_GATE_REASON_CODES.RUNTIME_CAPABILITY_UNKNOWN
        });
        if (runtimeCapabilityUnknownDecision) {
          return runtimeCapabilityUnknownDecision;
        }
      }
    }

    if (details.required_device_capability_key) {
      if (!safeDeviceUid) {
        pushWarning(warnings, 'device_uid_missing_for_capability_gate');
      } else {
        const deviceCapabilityRow = await getDeviceRuntimeCapabilityReportedState(db, {
          companyId: safeCompanyId,
          deviceUid: safeDeviceUid,
          capabilityKey: details.required_device_capability_key
        });
        const deviceCapability = toCapabilityReportedReadModel(deviceCapabilityRow, {
          staleMinutes: defaultDeviceCapabilityReportedStaleMinutes()
        });
        details.device_path_capability_status = deviceCapability.status;
        details.device_path_capability_reason = deviceCapability.reason;
        details.device_path_capability_reported_at = deviceCapability.reported_at;
        details.device_path_capability_reported_stale = deviceCapability.reported_stale;

        if (deviceCapability.status === CAPABILITY_STATUS.UNSUPPORTED) {
          return blocked(EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_UNSUPPORTED, details);
        }
        if (deviceCapability.status === CAPABILITY_STATUS.DISABLED) {
          return blocked(EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_DISABLED, details);
        }
        if (deviceCapability.status === CAPABILITY_STATUS.UNKNOWN) {
          const deviceCapabilityUnknownDecision = applyPolicyDecision({
            details,
            warnings,
            check: 'unknown_device_capability',
            observedStatus: 'unknown',
            policyLevel: executionPolicy.levels.unknown_device_capability,
            reason: deviceCapability.reason || 'device_path_capability_unknown',
            warningCode: 'device_path_capability_unknown',
            blockReasonCode: EXECUTION_GATE_REASON_CODES.DEVICE_PATH_CAPABILITY_UNKNOWN
          });
          if (deviceCapabilityUnknownDecision) {
            return deviceCapabilityUnknownDecision;
          }
        }
      }
    }
  }

  return allowed(details);
}

async function evaluateCommandIssuanceGate(db, params) {
  return evaluateRuntimeExecutionGate(db, {
    ...(isPlainObject(params) ? params : {}),
    gateMode: 'issuance'
  });
}

async function evaluateCommandAcceptanceGate(db, {
  companyId,
  polledAgentId,
  commandType,
  commandPayload
}) {
  const payload = isPlainObject(commandPayload) ? commandPayload : {};
  const runtimeContext = isPlainObject(payload.runtime_context) ? payload.runtime_context : {};
  const targetDeviceUid = normalizeText(payload.device_uid) || null;
  const commandSiteId = normalizeUuidLike(runtimeContext.site_id)
    || normalizeUuidLike(payload.site_id)
    || null;
  const boundAgentId = normalizeUuidLike(runtimeContext.bound_agent_id);
  const gate = await evaluateRuntimeExecutionGate(db, {
    companyId,
    targetAgentId: polledAgentId,
    commandType,
    deviceUid: targetDeviceUid,
    deviceSiteId: commandSiteId,
    agentSiteId: null,
    bindingAgentId: boundAgentId,
    gateMode: 'acceptance'
  });
  if (gate.allowed && !commandSiteId) {
    gate.details.warnings = Array.isArray(gate.details.warnings) ? gate.details.warnings : [];
    gate.details.warnings.push('legacy_command_without_site_context');
  }
  return gate;
}

module.exports = {
  EXECUTION_GATE_REASON_CODES,
  evaluateCommandIssuanceGate,
  evaluateCommandAcceptanceGate
};
