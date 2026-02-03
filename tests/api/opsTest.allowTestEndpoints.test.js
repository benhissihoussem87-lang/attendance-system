const assert = require('assert');

const dbEnvKeys = ['PGHOST', 'PGUSER', 'PGDATABASE'];
const priorDbEnv = dbEnvKeys.reduce((acc, key) => {
  acc[key] = process.env[key];
  return acc;
}, {});

dbEnvKeys.forEach(key => {
  if (!process.env[key]) {
    process.env[key] = 'test';
  }
});

const router = require('../../api/opsTest.routes');

async function withEnv(overrides, fn) {
  const prior = {
    ALLOW_TEST_ENDPOINTS: process.env.ALLOW_TEST_ENDPOINTS
  };

  Object.keys(overrides).forEach(key => {
    if (overrides[key] === null || typeof overrides[key] === 'undefined') {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  });

  try {
    return await fn();
  } finally {
    Object.keys(prior).forEach(key => {
      if (typeof prior[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = prior[key];
      }
    });
  }
}

function invokeModeRoute() {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      url: '/mode',
      headers: {},
      query: {},
      get: () => undefined
    };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, body: payload });
      },
      send(payload) {
        resolve({ statusCode: this.statusCode, body: payload });
      }
    };

    router.handle(req, res, err => {
      if (err) {
        reject(err);
      } else {
        resolve({ statusCode: res.statusCode });
      }
    });
  });
}

async function testAllowTestEndpointsTrue() {
  const result = await withEnv(
    { ALLOW_TEST_ENDPOINTS: 'true' },
    () => invokeModeRoute()
  );
  assert.notStrictEqual(result.statusCode, 404);
}

async function testAllowTestEndpointsOne() {
  const result = await withEnv(
    { ALLOW_TEST_ENDPOINTS: '1' },
    () => invokeModeRoute()
  );
  assert.notStrictEqual(result.statusCode, 404);
}

async function testAllowTestEndpointsDisabled() {
  const unsetResult = await withEnv(
    { ALLOW_TEST_ENDPOINTS: null },
    () => invokeModeRoute()
  );
  assert.strictEqual(unsetResult.statusCode, 404);

  const zeroResult = await withEnv(
    { ALLOW_TEST_ENDPOINTS: '0' },
    () => invokeModeRoute()
  );
  assert.strictEqual(zeroResult.statusCode, 404);
}

async function run() {
  await testAllowTestEndpointsTrue();
  await testAllowTestEndpointsOne();
  await testAllowTestEndpointsDisabled();
  console.log('opsTest allow_test_endpoints tests passed');
}

if (require.main === module) {
  run().finally(() => {
    dbEnvKeys.forEach(key => {
      if (typeof priorDbEnv[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = priorDbEnv[key];
      }
    });
  });
}

module.exports = { run };
