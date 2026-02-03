const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { listApiRoutes, normalizePath } = require('./openapi.routeInventory');

function readSpecText(specPath) {
  return fs.readFileSync(specPath, 'utf8').replace(/\r\n/g, '\n');
}

function parsePaths(text) {
  const paths = {};
  const lines = text.split('\n');
  let inPaths = false;
  let currentPath = null;
  let currentMethod = null;

  for (const line of lines) {
    if (!inPaths) {
      if (line.trim() === 'paths:') {
        inPaths = true;
      }
      continue;
    }

    if (line.length > 0 && !line.startsWith('  ') && line.trim() !== '') {
      break;
    }

    const pathMatch = line.match(/^  (\/\S+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentMethod = null;
      if (!paths[currentPath]) {
        paths[currentPath] = {};
      }
      continue;
    }

    const methodMatch = line.match(/^    (get|post|put|delete|patch|options|head):\s*$/i);
    if (methodMatch && currentPath) {
      currentMethod = methodMatch[1].toLowerCase();
      if (!paths[currentPath][currentMethod]) {
        paths[currentPath][currentMethod] = {};
      }
      continue;
    }

    const opMatch = line.match(/^      operationId:\s*(\S.*)\s*$/);
    if (opMatch && currentPath && currentMethod) {
      paths[currentPath][currentMethod].operationId = opMatch[1].trim();
    }
  }

  return paths;
}

function run() {
  const prevAllowTestEndpoints = process.env.ALLOW_TEST_ENDPOINTS;
  process.env.ALLOW_TEST_ENDPOINTS = 'true';

  const repoRoot = path.resolve(__dirname, '..', '..');
  const specPath = path.join(repoRoot, 'openapi', 'openapi.yaml');
  const text = readSpecText(specPath);
  const specPaths = parsePaths(text);

  const excluded = new Set([]);

  try {
    const routes = listApiRoutes()
      .map(route => ({
        method: route.method.toLowerCase(),
        path: normalizePath(route.path)
      }))
      .filter(route => route.path.startsWith('/api/'))
      .filter(route => !excluded.has(`${route.method.toUpperCase()} ${route.path}`));

    const missing = [];
    const missingMethod = [];
    const missingOperationId = [];

    routes.forEach(route => {
      const pathBlock = specPaths[route.path];
      if (!pathBlock) {
        missing.push(`${route.method.toUpperCase()} ${route.path}`);
        return;
      }
      const methodBlock = pathBlock[route.method];
      if (!methodBlock) {
        missingMethod.push(`${route.method.toUpperCase()} ${route.path}`);
        return;
      }
      if (!methodBlock.operationId) {
        missingOperationId.push(`${route.method.toUpperCase()} ${route.path}`);
      }
    });

    assert.strictEqual(
      missing.length,
      0,
      `OpenAPI spec missing paths:\n${missing.sort().join('\n')}`
    );
    assert.strictEqual(
      missingMethod.length,
      0,
      `OpenAPI spec missing methods:\n${missingMethod.sort().join('\n')}`
    );
    assert.strictEqual(
      missingOperationId.length,
      0,
      `OpenAPI spec missing operationId:\n${missingOperationId.sort().join('\n')}`
    );
  } finally {
    if (prevAllowTestEndpoints === undefined) {
      delete process.env.ALLOW_TEST_ENDPOINTS;
    } else {
      process.env.ALLOW_TEST_ENDPOINTS = prevAllowTestEndpoints;
    }
  }

  console.log('openapi full coverage tests passed');
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
