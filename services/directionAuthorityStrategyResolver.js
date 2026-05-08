const { normalizeText } = require('./agentAuth');
const {
  DIRECTION_AUTHORITY_STRATEGY,
  DIRECTION_AUTHORITY_STRATEGY_CONTRACT_VERSION
} = require('../contracts/directionAuthorityStrategyContract');

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeStrategyId(value) {
  return normalizeText(value).toLowerCase();
}

function deriveVendorFromDeviceUid(deviceUid, fallbackVendor = '') {
  const uid = normalizeText(deviceUid);
  if (!uid) {
    return normalizeLower(fallbackVendor) || 'unknown';
  }
  const [vendorToken] = uid.split(':');
  return normalizeLower(vendorToken || fallbackVendor) || 'unknown';
}

function resolveExplicitOverride(deviceProfile = {}) {
  if (!isPlainObject(deviceProfile)) {
    return null;
  }
  const direct = normalizeStrategyId(deviceProfile.direction_authority_strategy_id);
  if (direct) {
    return direct;
  }
  const authority = isPlainObject(deviceProfile.direction_authority)
    ? deviceProfile.direction_authority
    : {};
  const nested = normalizeStrategyId(authority.strategy_id);
  return nested || null;
}

function resolveVendorModelDefault({ vendor, model }) {
  const vendorLower = normalizeLower(vendor);
  const modelLower = normalizeLower(model);
  if (vendorLower === 'zkteco' && modelLower.includes('k80')) {
    return DIRECTION_AUTHORITY_STRATEGY.ZK_K80_RT_PREFERRED_WHEN_ELIGIBLE;
  }
  return null;
}

function resolveDirectionAuthorityStrategy(input = {}) {
  const deviceUid = normalizeText(input.device_uid);
  const vendor = normalizeLower(input.vendor || deriveVendorFromDeviceUid(deviceUid, 'unknown'));
  const deviceProfile = isPlainObject(input.device_profile) ? input.device_profile : {};
  const model = normalizeText(input.model || deviceProfile.model);

  const explicitOverride = resolveExplicitOverride(deviceProfile);
  if (explicitOverride) {
    return {
      resolved_strategy_id: explicitOverride,
      resolution_source: 'device_profile_override',
      resolution_vendor: vendor || 'unknown',
      resolution_model: model || null,
      contract_version: DIRECTION_AUTHORITY_STRATEGY_CONTRACT_VERSION
    };
  }

  const vendorDefault = resolveVendorModelDefault({ vendor, model });
  if (vendorDefault) {
    return {
      resolved_strategy_id: vendorDefault,
      resolution_source: 'vendor_model_default',
      resolution_vendor: vendor || 'unknown',
      resolution_model: model || null,
      contract_version: DIRECTION_AUTHORITY_STRATEGY_CONTRACT_VERSION
    };
  }

  const unknownVendor = !vendor || vendor === 'unknown';
  return {
    resolved_strategy_id: unknownVendor
      ? DIRECTION_AUTHORITY_STRATEGY.UNKNOWN_VENDOR_DEFAULT
      : DIRECTION_AUTHORITY_STRATEGY.LEGACY_FALLBACK_DEFAULT,
    resolution_source: unknownVendor ? 'unknown_vendor_default' : 'global_fallback_default',
    resolution_vendor: vendor || 'unknown',
    resolution_model: model || null,
    contract_version: DIRECTION_AUTHORITY_STRATEGY_CONTRACT_VERSION
  };
}

function resolveEffectiveDirectionAuthorityStrategyBehavior(resolved = {}) {
  // Behavior safety for this slice: keep effective behavior pinned to legacy fallback.
  return {
    effective_strategy_id: DIRECTION_AUTHORITY_STRATEGY.LEGACY_FALLBACK_DEFAULT,
    behavior_mode: 'legacy_behavior_pinned',
    behavior_change_applied: false,
    resolved_strategy_id: normalizeStrategyId(resolved.resolved_strategy_id)
      || DIRECTION_AUTHORITY_STRATEGY.LEGACY_FALLBACK_DEFAULT
  };
}

module.exports = {
  resolveDirectionAuthorityStrategy,
  resolveEffectiveDirectionAuthorityStrategyBehavior,
  deriveVendorFromDeviceUid
};
