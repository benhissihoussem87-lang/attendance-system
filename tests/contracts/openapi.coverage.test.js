const assert = require('assert');
const fs = require('fs');
const path = require('path');

const requiredPaths = [
  '/api/ops/health',
  '/api/ops/ready',
  '/api/ops/test/mode',
  '/api/device-events/import/preview',
  '/api/employees-registry',
  '/api/identity-mappings',
  '/api/identity-mappings/lookup',
  '/api/employees-registry/{person_id}'
];

function readSpec(specPath) {
  return fs.readFileSync(specPath, 'utf8');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findPathBlock(text, pathString) {
  const pathLinePattern = new RegExp(`\\n  ${escapeRegex(pathString)}:\\n`);
  let match = pathLinePattern.exec(text);
  if (!match) {
    const altPattern = new RegExp(`paths:\\n  ${escapeRegex(pathString)}:\\n`);
    match = altPattern.exec(text);
  }
  if (!match) {
    return null;
  }

  const blockStart = match.index + match[0].length;
  const rest = text.slice(blockStart);
  const nextPathMatch = rest.match(/\n  \/\S+:\n/);
  const blockEnd = nextPathMatch ? blockStart + nextPathMatch.index : text.length;
  return text.slice(blockStart, blockEnd);
}

function assertOperationId(text, pathString) {
  const block = findPathBlock(text, pathString);
  assert.ok(block, `OpenAPI spec missing path block for ${pathString}`);
  assert.ok(
    block.includes('operationId:'),
    `OpenAPI spec missing operationId for ${pathString}`
  );
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const specPath = path.join(repoRoot, 'openapi', 'openapi.yaml');
  const text = readSpec(specPath);
  const normalized = text.replace(/\r\n/g, '\n');

  requiredPaths.forEach(pathString => {
    assert.ok(normalized.includes(pathString), `OpenAPI spec missing path ${pathString}`);
    assertOperationId(normalized, pathString);
  });

  console.log('openapi coverage tests passed');
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
