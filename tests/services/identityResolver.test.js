const assert = require('assert');
const { resolvePersonIdForIdentifier } = require('../../services/identityResolver');

async function withEnv(overrides, fn) {
  const prior = {
    USE_IDENTITY_MAPPINGS: process.env.USE_IDENTITY_MAPPINGS,
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
    return await fn();
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

async function testRequireMappingsAcceptsTrueStrings() {
  const db = { query: async () => ({ rows: [] }) };

  const result = await withEnv(
    { USE_IDENTITY_MAPPINGS: 'true', REQUIRE_IDENTITY_MAPPINGS: 'true' },
    () => resolvePersonIdForIdentifier(db, {
      companyId: 'DEFAULT',
      provider: 'zkteco',
      identifierType: 'card',
      identifierValue: '123'
    })
  );

  assert.strictEqual(result.error, 'identity_mapping_missing');
}

async function testRequireMappingsAcceptsNumericStrings() {
  const db = { query: async () => ({ rows: [] }) };

  const result = await withEnv(
    { USE_IDENTITY_MAPPINGS: '1', REQUIRE_IDENTITY_MAPPINGS: '1' },
    () => resolvePersonIdForIdentifier(db, {
      companyId: 'DEFAULT',
      provider: 'zkteco',
      identifierType: 'card',
      identifierValue: '123'
    })
  );

  assert.strictEqual(result.error, 'identity_mapping_missing');
}

async function testMissingMappingAllowedWhenNotRequired() {
  const db = { query: async () => ({ rows: [] }) };

  const result = await withEnv(
    { USE_IDENTITY_MAPPINGS: 'true', REQUIRE_IDENTITY_MAPPINGS: 'false' },
    () => resolvePersonIdForIdentifier(db, {
      companyId: 'DEFAULT',
      provider: 'zkteco',
      identifierType: 'card',
      identifierValue: '123'
    })
  );

  assert.strictEqual(result.error, undefined);
  assert.strictEqual(result.person_id, '123');
  assert.strictEqual(result.applied, false);
}

async function run() {
  await testRequireMappingsAcceptsTrueStrings();
  await testRequireMappingsAcceptsNumericStrings();
  await testMissingMappingAllowedWhenNotRequired();
  console.log('identityResolver tests passed');
}

if (require.main === module) {
  run();
}

module.exports = { run };
