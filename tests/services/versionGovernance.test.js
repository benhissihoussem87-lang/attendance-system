const assert = require('assert');

const {
  parseSemverTriplet,
  compareSemverTriplets,
  evaluateAgentVersionSupport,
  normalizeRolloutChannel
} = require('../../services/versionGovernance');

function runSemverParsingCase() {
  const parsed = parseSemverTriplet('v1.2.3');
  assert.ok(parsed, 'v-prefixed semver should parse');
  assert.strictEqual(parsed.normalized, '1.2.3');
  assert.strictEqual(parseSemverTriplet('1.2'), null, 'invalid semver should not parse');
}

function runSemverComparisonCase() {
  assert.strictEqual(compareSemverTriplets('1.2.3', '1.2.3'), 0);
  assert.strictEqual(compareSemverTriplets('1.2.3', '1.2.4'), -1);
  assert.strictEqual(compareSemverTriplets('2.0.0', '1.9.9'), 1);
  assert.strictEqual(compareSemverTriplets('bad', '1.0.0'), null);
}

function runEvaluationCases() {
  const nowIso = new Date().toISOString();

  const supported = evaluateAgentVersionSupport({
    reportedVersion: '1.4.0',
    reportedAt: nowIso,
    minimumSupportedVersion: '1.2.0',
    targetVersion: '1.4.0',
    staleMinutes: 10
  });
  assert.strictEqual(supported.support_status, 'supported');
  assert.strictEqual(supported.support_level, 'healthy');

  const outdated = evaluateAgentVersionSupport({
    reportedVersion: '1.3.0',
    reportedAt: nowIso,
    minimumSupportedVersion: '1.2.0',
    targetVersion: '1.4.0',
    staleMinutes: 10
  });
  assert.strictEqual(outdated.support_status, 'outdated');
  assert.strictEqual(outdated.support_level, 'degraded');

  const unsupported = evaluateAgentVersionSupport({
    reportedVersion: '1.1.9',
    reportedAt: nowIso,
    minimumSupportedVersion: '1.2.0',
    targetVersion: null,
    staleMinutes: 10
  });
  assert.strictEqual(unsupported.support_status, 'unsupported');
  assert.strictEqual(unsupported.support_level, 'blocked');

  const staleUnknown = evaluateAgentVersionSupport({
    reportedVersion: '1.4.0',
    reportedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    minimumSupportedVersion: '1.2.0',
    targetVersion: null,
    staleMinutes: 10
  });
  assert.strictEqual(staleUnknown.support_status, 'unknown');
  assert.strictEqual(staleUnknown.support_reason, 'reported_version_stale');

  const missingUnknown = evaluateAgentVersionSupport({
    reportedVersion: null,
    reportedAt: nowIso,
    minimumSupportedVersion: '1.2.0',
    targetVersion: null,
    staleMinutes: 10
  });
  assert.strictEqual(missingUnknown.support_status, 'unknown');
  assert.strictEqual(missingUnknown.support_reason, 'reported_version_missing');
}

function runRolloutChannelCase() {
  assert.strictEqual(normalizeRolloutChannel('stable', 'beta'), 'stable');
  assert.strictEqual(normalizeRolloutChannel('beta', 'stable'), 'beta');
  assert.strictEqual(normalizeRolloutChannel('invalid', 'stable'), 'stable');
  assert.strictEqual(normalizeRolloutChannel('', 'stable'), 'stable');
}

async function run() {
  runSemverParsingCase();
  runSemverComparisonCase();
  runEvaluationCases();
  runRolloutChannelCase();
  console.log('versionGovernance service tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
