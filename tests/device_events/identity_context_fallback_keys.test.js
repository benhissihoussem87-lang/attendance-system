const assert = require('assert');
const { fallbackIdentityContext } = require('../../adapters/vendors/registry');

function assertContext({ vendor, rowData, expected }) {
  const result = fallbackIdentityContext({ vendor, rowData });
  assert.strictEqual(result.provider, expected.provider, 'provider mismatch');
  assert.strictEqual(result.identifier_type, expected.identifier_type, 'identifier_type mismatch');
  assert.strictEqual(result.identifier_value, expected.identifier_value, 'identifier_value mismatch');
}

try {
  assertContext({
    vendor: 'ZKTECO',
    rowData: { userid: '123' },
    expected: { provider: 'zkteco', identifier_type: 'pin', identifier_value: '123' }
  });

  assertContext({
    vendor: 'zkteco',
    rowData: { badgenumber: '9' },
    expected: { provider: 'zkteco', identifier_type: 'pin', identifier_value: '9' }
  });

  assertContext({
    vendor: 'ANVIZ',
    rowData: { pin: '77' },
    expected: { provider: 'anviz', identifier_type: 'person_id', identifier_value: '77' }
  });

  assertContext({
    vendor: 'generic_punchlog',
    rowData: { employee_id: 'E1' },
    expected: { provider: 'generic_punchlog', identifier_type: 'person_id', identifier_value: 'E1' }
  });

  assertContext({
    vendor: 'unknown_vendor',
    rowData: { person_id: 'P1' },
    expected: { provider: 'unknown_vendor', identifier_type: 'person_id', identifier_value: 'P1' }
  });

  console.log('PASS: identity_context_fallback_keys');
  process.exit(0);
} catch (err) {
  console.error('FAIL: identity_context_fallback_keys');
  console.error(err);
  process.exit(1);
}
