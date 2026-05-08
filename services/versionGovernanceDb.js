const { normalizeText } = require('./agentAuth');
const {
  normalizeVersionText,
  normalizeRolloutChannel
} = require('./versionGovernance');

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(value) {
  if (isPlainObject(value)) {
    return value;
  }
  if (!value || typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeIsoOrNull(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString();
  }
  if (typeof value === 'number') {
    const fromNumber = new Date(value);
    if (Number.isNaN(fromNumber.getTime())) {
      return null;
    }
    return fromNumber.toISOString();
  }
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function normalizePolicyRow(row) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  return {
    policy_scope: normalizeText(row.policy_scope).toLowerCase(),
    company_id: normalizeText(row.company_id) || null,
    minimum_supported_version: normalizeVersionText(row.minimum_supported_version),
    target_version: normalizeVersionText(row.target_version),
    rollout_channel: normalizeRolloutChannel(row.rollout_channel, 'stable'),
    metadata: parseJsonObject(row.metadata),
    updated_by_key_id: normalizeText(row.updated_by_key_id) || null,
    created_at: normalizeIsoOrNull(row.created_at),
    updated_at: normalizeIsoOrNull(row.updated_at)
  };
}

function defaultGlobalPolicy() {
  return {
    policy_scope: 'global',
    company_id: null,
    minimum_supported_version: '0.0.0',
    target_version: null,
    rollout_channel: 'stable',
    metadata: {
      source: 'default.global_policy_fallback'
    },
    updated_by_key_id: null,
    created_at: null,
    updated_at: null
  };
}

async function getEffectiveAgentVersionPolicy(db, { companyId }) {
  const safeCompanyId = normalizeText(companyId) || 'DEFAULT';
  const res = await db.query(
    `
    SELECT
      policy_scope,
      company_id,
      minimum_supported_version,
      target_version,
      rollout_channel,
      metadata,
      updated_by_key_id,
      created_at,
      updated_at
    FROM agent_version_governance_policies
    WHERE policy_scope = 'global'
       OR (policy_scope = 'company' AND company_id = $1)
    ORDER BY
      CASE policy_scope WHEN 'company' THEN 0 ELSE 1 END,
      updated_at DESC,
      created_at DESC
    `,
    [safeCompanyId]
  );

  let globalPolicy = null;
  let companyPolicyOverride = null;
  for (const row of res.rows) {
    const normalized = normalizePolicyRow(row);
    if (!normalized) {
      continue;
    }
    if (normalized.policy_scope === 'company' && !companyPolicyOverride) {
      companyPolicyOverride = normalized;
      continue;
    }
    if (normalized.policy_scope === 'global' && !globalPolicy) {
      globalPolicy = normalized;
    }
  }

  if (!globalPolicy) {
    globalPolicy = defaultGlobalPolicy();
  }

  const effectivePolicy = companyPolicyOverride || globalPolicy;
  return {
    company_id: safeCompanyId,
    global_policy: globalPolicy,
    company_policy_override: companyPolicyOverride,
    effective_policy: {
      ...effectivePolicy,
      policy_source: companyPolicyOverride ? 'company_override' : 'global'
    }
  };
}

async function upsertCompanyAgentVersionPolicy(db, {
  companyId,
  minimumSupportedVersion,
  targetVersion,
  rolloutChannel,
  updatedByKeyId,
  metadata
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeMinimumSupportedVersion = normalizeVersionText(minimumSupportedVersion);
  if (!safeCompanyId || !safeMinimumSupportedVersion) {
    throw { code: 'invalid_request', detail: 'company_id and minimum_supported_version are required' };
  }

  const safeTargetVersion = normalizeVersionText(targetVersion);
  const safeRolloutChannel = normalizeRolloutChannel(rolloutChannel, 'stable');
  const safeUpdatedByKeyId = normalizeText(updatedByKeyId) || null;
  const safeMetadata = isPlainObject(metadata) ? metadata : {};

  const res = await db.query(
    `
    INSERT INTO agent_version_governance_policies (
      policy_scope,
      company_id,
      minimum_supported_version,
      target_version,
      rollout_channel,
      metadata,
      updated_by_key_id
    )
    VALUES (
      'company',
      $1,
      $2,
      $3,
      $4,
      $5::jsonb,
      $6
    )
    ON CONFLICT (company_id) WHERE policy_scope = 'company' DO UPDATE
      SET minimum_supported_version = EXCLUDED.minimum_supported_version,
          target_version = EXCLUDED.target_version,
          rollout_channel = EXCLUDED.rollout_channel,
          metadata = agent_version_governance_policies.metadata || EXCLUDED.metadata,
          updated_by_key_id = EXCLUDED.updated_by_key_id,
          updated_at = now()
    RETURNING
      policy_scope,
      company_id,
      minimum_supported_version,
      target_version,
      rollout_channel,
      metadata,
      updated_by_key_id,
      created_at,
      updated_at
    `,
    [
      safeCompanyId,
      safeMinimumSupportedVersion,
      safeTargetVersion,
      safeRolloutChannel,
      JSON.stringify(safeMetadata),
      safeUpdatedByKeyId
    ]
  );

  return normalizePolicyRow(res.rows[0] || null);
}

async function getAgentRuntimeVersionReportedState(db, {
  companyId,
  agentId
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeAgentId = normalizeText(agentId);
  if (!safeCompanyId || !safeAgentId) {
    return null;
  }

  const res = await db.query(
    `
    SELECT
      company_id,
      agent_id,
      site_id,
      reported_version,
      rollout_channel,
      reported_at,
      metadata,
      created_at,
      updated_at
    FROM agent_runtime_version_reported_state
    WHERE company_id = $1
      AND agent_id = $2
    LIMIT 1
    `,
    [safeCompanyId, safeAgentId]
  );

  return res.rows[0] || null;
}

async function upsertAgentRuntimeVersionReportedState(db, {
  companyId,
  agentId,
  siteId,
  reportedVersion,
  rolloutChannel,
  reportedAt,
  metadata
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeAgentId = normalizeText(agentId);
  const safeReportedVersion = normalizeVersionText(reportedVersion);
  if (!safeCompanyId || !safeAgentId || !safeReportedVersion) {
    return null;
  }

  const safeSiteId = normalizeText(siteId) || null;
  const safeReportedAt = normalizeIsoOrNull(reportedAt) || new Date().toISOString();
  const safeRolloutChannel = normalizeRolloutChannel(rolloutChannel, null);
  const safeMetadata = isPlainObject(metadata) ? metadata : {};

  const res = await db.query(
    `
    INSERT INTO agent_runtime_version_reported_state (
      company_id,
      agent_id,
      site_id,
      reported_version,
      rollout_channel,
      reported_at,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)
    ON CONFLICT (company_id, agent_id) DO UPDATE
      SET site_id = COALESCE(EXCLUDED.site_id, agent_runtime_version_reported_state.site_id),
          reported_version = EXCLUDED.reported_version,
          rollout_channel = COALESCE(EXCLUDED.rollout_channel, agent_runtime_version_reported_state.rollout_channel),
          reported_at = GREATEST(agent_runtime_version_reported_state.reported_at, EXCLUDED.reported_at),
          metadata = agent_runtime_version_reported_state.metadata || EXCLUDED.metadata,
          updated_at = now()
    RETURNING
      company_id,
      agent_id,
      site_id,
      reported_version,
      rollout_channel,
      reported_at,
      metadata,
      created_at,
      updated_at
    `,
    [
      safeCompanyId,
      safeAgentId,
      safeSiteId,
      safeReportedVersion,
      safeRolloutChannel,
      safeReportedAt,
      JSON.stringify(safeMetadata)
    ]
  );

  return res.rows[0] || null;
}

function extractVersionReportFromHeartbeatPayload(payload) {
  if (!isPlainObject(payload)) {
    return {
      reported_version: null,
      rollout_channel: null
    };
  }

  const reportedVersion = normalizeVersionText(payload.agent_version)
    || normalizeVersionText(payload.version)
    || null;

  return {
    reported_version: reportedVersion,
    rollout_channel: normalizeRolloutChannel(payload.rollout_channel, null)
  };
}

module.exports = {
  defaultGlobalPolicy,
  getEffectiveAgentVersionPolicy,
  upsertCompanyAgentVersionPolicy,
  getAgentRuntimeVersionReportedState,
  upsertAgentRuntimeVersionReportedState,
  extractVersionReportFromHeartbeatPayload
};
