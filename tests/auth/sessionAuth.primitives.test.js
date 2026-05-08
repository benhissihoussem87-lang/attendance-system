const assert = require('assert');
const {
  hashPassword,
  verifyPassword,
  hashToken,
  SESSION_COOKIE_NAME
} = require('../../services/auth/sessionAuth');

async function run() {
  const password = 'CorrectHorseBatteryStaple1!';
  const encoded = await hashPassword(password);
  assert.notStrictEqual(encoded, password, 'password hash must not be plaintext');
  assert.ok(encoded.startsWith('scrypt_v1$'), 'password hash should encode algorithm');
  assert.strictEqual(await verifyPassword(password, encoded), true, 'valid password should verify');
  assert.strictEqual(await verifyPassword('wrong-password', encoded), false, 'invalid password should fail');

  const token = 'session-token-value';
  const tokenHash = hashToken(token);
  assert.notStrictEqual(tokenHash, token, 'session token hash must not be plaintext');
  assert.strictEqual(tokenHash.length, 64, 'sha256 session token hash should be hex encoded');
  assert.strictEqual(typeof SESSION_COOKIE_NAME, 'string');
  assert.ok(SESSION_COOKIE_NAME.length > 0, 'session cookie name is required');

  console.log('PASS: session auth primitives');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
