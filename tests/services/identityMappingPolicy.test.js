const assert = require('assert');
const {
  getIdentityMappingPolicy,
  shouldRequireIdentityMappingForProvider
} = require('../../services/identityMappingPolicy');

function withEnv(overrides, fn) {
  const prior = {
    IDENTITY_MAPPING_POLICY: process.env.IDENTITY_MAPPING_POLICY,
    REQUIRE_IDENTITY_MAPPINGS: process.env.REQUIRE_IDENTITY_MAPPINGS
  };

  Object.keys(overrides).forEach(key => {
    if (overrides[key] === null || typeof overrides[key] === 'undefined') {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  });

  try {
    fn();
  } finally {
    Object.keys(prior).forEach(key => {
      if (typeof prior[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = prior[key];
      }
    });
  }
}

function testPolicyDefaultAll() {
  withEnv({ IDENTITY_MAPPING_POLICY: null }, () => {
    assert.strictEqual(getIdentityMappingPolicy(), 'all');
  });
}

function testPolicyVendor() {
  withEnv({ IDENTITY_MAPPING_POLICY: 'vendor' }, () => {
    assert.strictEqual(getIdentityMappingPolicy(), 'vendor');
  });
}

function testPolicyInvalidFallsBack() {
  withEnv({ IDENTITY_MAPPING_POLICY: 'nope' }, () => {
    assert.strictEqual(getIdentityMappingPolicy(), 'all');
  });
}

function testRequireMappingsGenericProvider() {
  withEnv({ REQUIRE_IDENTITY_MAPPINGS: null, IDENTITY_MAPPING_POLICY: 'vendor' }, () => {
    assert.strictEqual(shouldRequireIdentityMappingForProvider('generic'), false);
  });
  withEnv({ REQUIRE_IDENTITY_MAPPINGS: '1', IDENTITY_MAPPING_POLICY: 'vendor' }, () => {
    assert.strictEqual(shouldRequireIdentityMappingForProvider('generic'), false);
  });
  withEnv({ REQUIRE_IDENTITY_MAPPINGS: '1', IDENTITY_MAPPING_POLICY: 'all' }, () => {
    assert.strictEqual(shouldRequireIdentityMappingForProvider('generic'), true);
  });
}

function testRequireMappingsVendorProvider() {
  withEnv({ REQUIRE_IDENTITY_MAPPINGS: null, IDENTITY_MAPPING_POLICY: 'vendor' }, () => {
    assert.strictEqual(shouldRequireIdentityMappingForProvider('zkteco'), false);
  });
  withEnv({ REQUIRE_IDENTITY_MAPPINGS: '1', IDENTITY_MAPPING_POLICY: 'vendor' }, () => {
    assert.strictEqual(shouldRequireIdentityMappingForProvider('zkteco'), true);
  });
  withEnv({ REQUIRE_IDENTITY_MAPPINGS: '1', IDENTITY_MAPPING_POLICY: 'all' }, () => {
    assert.strictEqual(shouldRequireIdentityMappingForProvider('zkteco'), true);
  });
}

function run() {
  testPolicyDefaultAll();
  testPolicyVendor();
  testPolicyInvalidFallsBack();
  testRequireMappingsGenericProvider();
  testRequireMappingsVendorProvider();
  console.log('identityMappingPolicy tests passed');
}

if (require.main === module) {
  run();
}

module.exports = { run };
