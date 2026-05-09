const assert = require('assert');
const { toBool, toLowerTrim } = require('../../services/envBool');

function testToLowerTrim() {
  assert.strictEqual(toLowerTrim('  HELLO  '), 'hello');
  assert.strictEqual(toLowerTrim('World'), 'world');
  assert.strictEqual(toLowerTrim(123), '');
  assert.strictEqual(toLowerTrim(null), '');
  assert.strictEqual(toLowerTrim(undefined), '');
  console.log('testToLowerTrim passed');
}

function testToBool() {
  assert.strictEqual(toBool('1'), true);
  assert.strictEqual(toBool('true'), true);
  assert.strictEqual(toBool(' TRUE '), true);
  assert.strictEqual(toBool('1 '), true);

  assert.strictEqual(toBool('0'), false);
  assert.strictEqual(toBool('false'), false);
  assert.strictEqual(toBool('something'), false);
  assert.strictEqual(toBool(''), false);
  assert.strictEqual(toBool(null), false);
  assert.strictEqual(toBool('yes'), false);

  console.log('testToBool passed');
}

function run() {
  testToLowerTrim();
  testToBool();
  console.log('envBool tests passed');
}

if (require.main === module) {
  run();
}

module.exports = { run };
