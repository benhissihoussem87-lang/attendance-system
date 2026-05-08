const assert = require('assert');
const cli = require('../../scripts/agent/pull-events-probe');

function runParseCase() {
  const parsed = cli.parseArgs([
    '--host', '192.168.1.20',
    '--port', '4370',
    '--auth-password', '1234',
    '--device-uid', 'zkteco:sn:ABC001',
    '--vendor', 'zkteco',
    '--device-timezone', 'Africa/Tunis',
    '--since-utc', '2026-03-06T08:00:00Z',
    '--max-events', '800',
    '--timeout-ms', '2000',
    '--max-packets', '5000',
    '--checktype-map', '{"0":"IN","1":"OUT"}',
    '--mock',
    '--compact'
  ]);

  assert.strictEqual(parsed.host, '192.168.1.20');
  assert.strictEqual(parsed.port, 4370);
  assert.strictEqual(parsed.authPassword, 1234);
  assert.strictEqual(parsed.deviceUid, 'zkteco:sn:ABC001');
  assert.strictEqual(parsed.vendor, 'zkteco');
  assert.strictEqual(parsed.deviceTimezone, 'Africa/Tunis');
  assert.strictEqual(parsed.sinceUtc, '2026-03-06T08:00:00Z');
  assert.strictEqual(parsed.maxEvents, 800);
  assert.strictEqual(parsed.timeoutMs, 2000);
  assert.strictEqual(parsed.maxPackets, 5000);
  assert.strictEqual(parsed.mockMode, true);
  assert.strictEqual(parsed.pretty, false);
  assert.strictEqual(parsed.checktypeMap['0'], 'IN');
}

function run() {
  runParseCase();
  console.log('pull events probe cli tests passed');
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
