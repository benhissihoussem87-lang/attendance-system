const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readSpec(specPath) {
  return fs.readFileSync(specPath, 'utf8');
}

function runSpectral(specPath, rulesetPath) {
  const spectralBin = path.join(
    __dirname,
    '..',
    '..',
    'node_modules',
    '@stoplight',
    'spectral-cli',
    'dist',
    'index.js'
  );
  const result = spawnSync(
    process.execPath,
    [spectralBin, 'lint', specPath, '-r', rulesetPath],
    { stdio: 'inherit', shell: false }
  );
  return result.status === 0;
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const specPath = path.join(repoRoot, 'openapi', 'openapi.yaml');
  const rulesetPath = path.join(repoRoot, '.spectral.yaml');

  const text = readSpec(specPath);
  assert.ok(text.includes('openapi: 3.1.0'), 'openapi version must be 3.1.0');

  const ok = runSpectral(specPath, rulesetPath);
  assert.ok(ok, 'Spectral lint failed');

  console.log('openapi lint tests passed');
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
