const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function normalizeText(value) {
  return (value || '').toString().replace(/\r\n/g, '\n').trimEnd();
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const generatorPath = path.join(repoRoot, 'scripts', 'build-endpoint-inventory.js');
  const reportPath = path.join(repoRoot, 'docs', 'openapi', 'endpoint-inventory-report.md');
  const inventoryJsonPath = path.join(repoRoot, 'docs', 'openapi', 'endpoint-inventory.json');

  const beforeReport = fs.existsSync(reportPath)
    ? fs.readFileSync(reportPath, 'utf8')
    : '';

  const result = spawnSync(process.execPath, [generatorPath], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error([
      'Failed to regenerate OpenAPI endpoint inventory artifacts.',
      result.stdout || '',
      result.stderr || ''
    ].join('\n').trim());
  }

  assert.ok(
    fs.existsSync(inventoryJsonPath),
    'Missing docs/openapi/endpoint-inventory.json after generation.'
  );
  assert.ok(
    fs.existsSync(reportPath),
    'Missing docs/openapi/endpoint-inventory-report.md after generation.'
  );

  const afterReport = fs.readFileSync(reportPath, 'utf8');
  const beforeNormalized = normalizeText(beforeReport);
  const afterNormalized = normalizeText(afterReport);

  assert.strictEqual(
    afterNormalized,
    beforeNormalized,
    [
      'OpenAPI inventory report is stale.',
      'Run `node .\\scripts\\build-endpoint-inventory.js` and commit docs/openapi/endpoint-inventory-report.md.'
    ].join('\n')
  );

  console.log('openapi inventory freshness tests passed');
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
