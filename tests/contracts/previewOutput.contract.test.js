const assert = require('assert');
const http = require('http');
const https = require('https');
const { adminHeaders, getCompanyId, operatorHeaders } = require('./_helpers/auth');

function requestJson({ method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: { ...operatorHeaders(), ...headers }
    };

    let payload = null;
    if (body !== undefined && body !== null) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!options.headers['content-type']) {
        options.headers['content-type'] = typeof body === 'string'
          ? 'text/plain'
          : 'application/json';
      }
      options.headers['content-length'] = Buffer.byteLength(payload);
    }

    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed = null;
        if (data) {
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            return reject(new Error(`Expected JSON response from ${url}, got: ${data.slice(0, 200)}`));
          }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

function ensureBoolean(value, label) {
  assert.strictEqual(typeof value, 'boolean', `${label} must be boolean`);
}

function ensureString(value, label) {
  assert.strictEqual(typeof value, 'string', `${label} must be string`);
}

function ensureNumber(value, label) {
  assert.strictEqual(typeof value, 'number', `${label} must be number`);
}

function ensureArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be array`);
}

function assertErrorEnvelope(body) {
  assert.ok(body, 'error response body is required');
  ensureString(body.error, 'error.error');
  ensureString(body.code, 'error.code');
  ensureString(body.message, 'error.message');
}

function getBaseUrl() {
  return process.env.BASE_URL || 'http://localhost:3000';
}

function logUnexpectedResponse(label, response) {
  if (response && response.status === 200) {
    return;
  }
  const body = response && response.body !== undefined
    ? JSON.stringify(response.body)
    : 'null';
  console.error(`${label} unexpected response: status=${response ? response.status : 'null'} body=${body}`);
}

async function fetchMode(baseUrl) {
  const res = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/ops/test/mode`,
    headers: adminHeaders()
  });
  if (res.status === 404) {
    throw new Error('ALLOW_TEST_ENDPOINTS is not enabled; /api/ops/test/mode returned 404');
  }
  assert.strictEqual(res.status, 200, 'mode endpoint should return 200');
  const mode = res.body;
  assert.ok(mode, 'mode response body is required');
  ensureBoolean(mode.allow_test_endpoints, 'mode.allow_test_endpoints');
  ensureBoolean(mode.use_identity_mappings, 'mode.use_identity_mappings');
  ensureBoolean(mode.require_identity_mappings, 'mode.require_identity_mappings');
  ensureString(mode.identity_mapping_policy, 'mode.identity_mapping_policy');
  return mode;
}

function assertPreviewShape(preview) {
  assert.ok(preview, 'preview response body is required');
  ensureString(preview.system_version, 'preview.system_version');
  ensureString(preview.contract, 'preview.contract');
  ensureString(preview.import_version, 'preview.import_version');
  ensureNumber(preview.total_rows, 'preview.total_rows');
  ensureNumber(preview.valid_rows, 'preview.valid_rows');
  ensureNumber(preview.invalid_rows, 'preview.invalid_rows');
  ensureArray(preview.errors || [], 'preview.errors');
  ensureArray(preview.sample_valid_rows || [], 'preview.sample_valid_rows');
  ensureArray(preview.sample_rows || [], 'preview.sample_rows');

  assert.strictEqual(
    preview.valid_rows + preview.invalid_rows,
    preview.total_rows,
    'valid_rows + invalid_rows must equal total_rows'
  );

  if (preview.invalid_rows === 0) {
    assert.strictEqual(preview.errors.length, 0, 'errors must be empty when invalid_rows == 0');
  } else {
    assert.ok(preview.errors.length > 0, 'errors must be non-empty when invalid_rows > 0');
  }

  preview.errors.forEach(err => {
    assert.ok(err && typeof err === 'object', 'error entries must be objects');
    ensureString(err.code, 'error.code');
    ensureString(err.message, 'error.message');
  });
}

async function putIdentityMapping(baseUrl, companyId, payload) {
  const res = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'application/json' },
    body: payload
  });
  assert.strictEqual(res.status, 200, 'identity mapping PUT should return 200');
}

async function putEmployee(baseUrl, companyId, personId, body) {
  const res = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/employees-registry/${encodeURIComponent(personId)}?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'application/json' },
    body
  });
  assert.strictEqual(res.status, 200, 'employee PUT should return 200');
}

async function testPreviewContract() {
  const baseUrl = getBaseUrl();
  const mode = await fetchMode(baseUrl);
  if (!mode.allow_test_endpoints) {
    throw new Error('ALLOW_TEST_ENDPOINTS must be enabled for contract tests');
  }

  const companyId = getCompanyId();
  const runId = Math.random().toString(16).slice(2, 10);
  const vendorProvider = 'zkteco';
  const vendorIdentifier = `ZK-${runId}`;
  const personVendor = `preview_vendor_${runId}`;
  const employeePayload = {
    full_name: `Preview Test ${runId}`,
    employee_code: `EMP-${runId}`,
    active: true,
    metadata: {}
  };

  const csvMissingVendor = [
    'badgenumber,checktime,checktype,sn',
    `${vendorIdentifier},2026-01-07 08:00:00,I,TEST-SN-${runId}`
  ].join('\n');

  const previewMissing = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/device-events/import/preview?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'x-vendor': vendorProvider, 'content-type': 'text/plain' },
    body: csvMissingVendor
  });

  logUnexpectedResponse('previewMissing', previewMissing);
  assert.strictEqual(previewMissing.status, 200, 'preview should return 200');
  const previewMissingBody = previewMissing.body;
  assertPreviewShape(previewMissingBody);

  const errorCodes = (previewMissingBody.errors || []).map(err => err && err.code);
  if (errorCodes.includes('UNKNOWN_CHECKTYPE')) {
    throw new Error('Preview returned UNKNOWN_CHECKTYPE; ensure ZKTECO_CHECKTYPE_MAP is set');
  }

  const policy = (mode.identity_mapping_policy || 'all').trim().toLowerCase();
  if (mode.require_identity_mappings && policy === 'vendor') {
    assert.ok(
      errorCodes.includes('identity_mapping_missing'),
      'identity_mapping_missing should be present when REQUIRE_IDENTITY_MAPPINGS is enabled and policy=vendor'
    );
    assert.ok(
      previewMissingBody.invalid_rows >= 1,
      'invalid_rows must be >= 1 when identity mapping is required and missing'
    );
  } else {
    assert.ok(
      !errorCodes.includes('identity_mapping_missing'),
      'identity_mapping_missing should not appear when mappings are not required'
    );
  }

  if (mode.use_employees_registry) {
    // When registry is enabled, mappings require an existing employee.
    await putEmployee(baseUrl, companyId, personVendor, employeePayload);
  }
  await putIdentityMapping(baseUrl, companyId, {
    provider: vendorProvider,
    identifier_type: 'pin',
    identifier_value: vendorIdentifier,
    person_id: personVendor,
    active: true,
    metadata: {}
  });

  const previewMapped = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/device-events/import/preview?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'x-vendor': vendorProvider, 'content-type': 'text/plain' },
    body: csvMissingVendor
  });

  logUnexpectedResponse('previewMapped', previewMapped);
  assert.strictEqual(previewMapped.status, 200, 'preview with mapping should return 200');
  const previewMappedBody = previewMapped.body;
  assertPreviewShape(previewMappedBody);
  assert.ok(previewMappedBody.valid_rows >= 1, 'expected at least one valid row with mapping');
  assert.strictEqual(previewMappedBody.invalid_rows, 0, 'expected zero invalid rows with mapping');

  const sampleRows = (previewMappedBody.sample_rows && previewMappedBody.sample_rows.length > 0)
    ? previewMappedBody.sample_rows
    : previewMappedBody.sample_valid_rows;
  assert.ok(sampleRows && sampleRows.length > 0, 'expected sample rows for mapped preview');

  const sample = sampleRows[0];
  assert.ok(sample && typeof sample === 'object', 'sample row must be object');
  ensureNumber(sample.row_number, 'sample.row_number');
  assert.ok(sample.data && typeof sample.data === 'object', 'sample.data must be object');
  ensureString(sample.data.resolved_person_id, 'sample.data.resolved_person_id');
  ensureBoolean(sample.data.identity_mapping_applied, 'sample.data.identity_mapping_applied');
  ensureString(sample.data.identity_mapping_reason || '', 'sample.data.identity_mapping_reason');
  assert.strictEqual(sample.data.resolved_person_id, personVendor, 'resolved_person_id should match mapping');
  assert.strictEqual(sample.data.identity_mapping_applied, true, 'identity_mapping_applied should be true');
  assert.ok(
    sample.data.raw_payload && sample.data.raw_payload.identity,
    'sample.data.raw_payload.identity is required'
  );
  assert.strictEqual(
    sample.data.raw_payload.identity.mapping_applied,
    true,
    'raw_payload.identity.mapping_applied should be true'
  );
}

async function testCsvErrorEnvelope() {
  const baseUrl = getBaseUrl();
  const companyId = getCompanyId();

  const previewEmpty = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/device-events/import/preview?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'text/plain' },
    body: ''
  });

  assert.strictEqual(previewEmpty.status, 400, 'preview empty should return 400');
  assertErrorEnvelope(previewEmpty.body);
  assert.strictEqual(previewEmpty.body.code, 'CSV_VALIDATION', 'preview empty code should be CSV_VALIDATION');
  assert.strictEqual(previewEmpty.body.message, 'CSV validation failed', 'preview empty message mismatch');
  assert.ok(
    previewEmpty.body.details && previewEmpty.body.details.kind === 'csv_validation',
    'preview empty details.kind should be csv_validation'
  );
  assert.strictEqual(
    previewEmpty.body.details.error,
    'CSV content is required',
    'preview empty details.error mismatch'
  );

  const previewUnknownVendor = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/device-events/import/preview?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'text/plain', 'x-vendor': 'unknown_vendor_test' },
    body: 'person_id,event_time,direction\np1,2026-01-07 08:00:00,IN'
  });

  assert.strictEqual(previewUnknownVendor.status, 400, 'preview unknown vendor should return 400');
  assertErrorEnvelope(previewUnknownVendor.body);
  assert.strictEqual(
    previewUnknownVendor.body.code,
    'IMPORT_ERROR',
    'preview unknown vendor code should be IMPORT_ERROR'
  );
  assert.ok(
    previewUnknownVendor.body.details && previewUnknownVendor.body.details.kind === 'import_error',
    'preview unknown vendor details.kind should be import_error'
  );
  assert.strictEqual(
    previewUnknownVendor.body.details.error,
    'unknown_vendor',
    'preview unknown vendor details.error mismatch'
  );
  ensureArray(previewUnknownVendor.body.details.supported_vendors || [], 'supported_vendors');

  const commitMissingColumns = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/device-events/import/commit?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'text/plain' },
    body: 'person_id,event_time\np1,2026-01-07 08:00:00'
  });

  assert.strictEqual(commitMissingColumns.status, 400, 'commit missing columns should return 400');
  assertErrorEnvelope(commitMissingColumns.body);
  assert.strictEqual(
    commitMissingColumns.body.code,
    'CSV_VALIDATION',
    'commit missing columns code should be CSV_VALIDATION'
  );
  assert.ok(
    commitMissingColumns.body.details && commitMissingColumns.body.details.kind === 'csv_validation',
    'commit missing columns details.kind should be csv_validation'
  );
  ensureArray(commitMissingColumns.body.details.errors || [], 'commit missing columns details.errors');
}

async function run() {
  await testPreviewContract();
  await testCsvErrorEnvelope();
  console.log('preview output contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
