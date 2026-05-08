const assert = require('assert');
const probeCli = require('../../scripts/agent/discovery-probe');

function runParseArgsCase() {
  const args = probeCli.parseArgs([
    '--target', '192.168.1.0/24',
    '--host', '192.168.1.20',
    '--adapter', 'zkteco',
    '--timeout-ms', '900',
    '--max-hosts', '64',
    '--auth-password', '1234',
    '--mock',
    '--compact'
  ]);

  assert.deepStrictEqual(args.targets, ['192.168.1.0/24']);
  assert.deepStrictEqual(args.hosts, ['192.168.1.20']);
  assert.strictEqual(args.adapter, 'zkteco');
  assert.strictEqual(args.timeoutMs, 900);
  assert.strictEqual(args.maxHosts, 64);
  assert.strictEqual(args.authPassword, 1234);
  assert.strictEqual(args.mockMode, true);
  assert.strictEqual(args.pretty, false);
}

function runBuildTargetsCase() {
  const targets = probeCli.buildTargets({
    targets: ['192.168.1.0/24'],
    hosts: ['192.168.1.20', '192.168.1.20']
  });
  assert.deepStrictEqual(targets, ['192.168.1.0/24', '192.168.1.20/32']);
}

function run() {
  runParseArgsCase();
  runBuildTargetsCase();
  console.log('discovery probe cli tests passed');
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
