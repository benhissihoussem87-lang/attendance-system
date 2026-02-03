const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSpec(specPath) {
  return fs.readFileSync(specPath, 'utf8');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const specPath = path.join(repoRoot, 'openapi', 'openapi.yaml');
  const text = readSpec(specPath);

  assert.ok(text.includes('/api/devices'), 'OpenAPI spec missing /api/devices');
  assert.ok(text.includes('/api/devices/{device_uid}'), 'OpenAPI spec missing /api/devices/{device_uid}');
  assert.ok(text.includes('operationId: listDevices'), 'OpenAPI spec missing operationId listDevices');
  assert.ok(text.includes('operationId: getDevice'), 'OpenAPI spec missing operationId getDevice');
  assert.ok(text.includes('operationId: upsertDevice'), 'OpenAPI spec missing operationId upsertDevice');
  assert.ok(text.includes('name: device-registry'), 'OpenAPI spec missing device-registry tag');
  assert.ok(text.includes('DeviceUpsertRequest:'), 'OpenAPI spec missing DeviceUpsertRequest schema');
  assert.ok(text.includes('Device:'), 'OpenAPI spec missing Device schema');
  assert.ok(text.includes('DevicesListResponse:'), 'OpenAPI spec missing DevicesListResponse schema');

  console.log('openapi device registry coverage tests passed');
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = { run };
