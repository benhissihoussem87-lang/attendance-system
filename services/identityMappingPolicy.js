function getIdentityMappingPolicy() {
  const rawValue = process.env.IDENTITY_MAPPING_POLICY;
  if (typeof rawValue !== 'string') {
    return 'all';
  }
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'vendor') {
    return 'vendor';
  }
  if (normalized === 'all') {
    return 'all';
  }
  return 'all';
}

function shouldRequireIdentityMappingForProvider(provider) {
  if (process.env.REQUIRE_IDENTITY_MAPPINGS !== '1') {
    return false;
  }

  const policy = getIdentityMappingPolicy();
  const providerValue = (typeof provider === 'string' && provider.trim())
    ? provider.trim().toLowerCase()
    : 'generic';

  if (policy === 'vendor') {
    return providerValue !== 'generic';
  }

  return true;
}

module.exports = {
  getIdentityMappingPolicy,
  shouldRequireIdentityMappingForProvider
};
