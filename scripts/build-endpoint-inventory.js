const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const apiDir = path.join(repoRoot, 'api');
const serverPath = path.join(repoRoot, 'server.js');
const outputDir = path.join(repoRoot, 'docs', 'openapi');
const inventoryPath = path.join(outputDir, 'endpoint-inventory.json');
const reportPath = path.join(outputDir, 'endpoint-inventory-report.md');
const specPath = path.join(repoRoot, 'openapi', 'openapi.yaml');

function readFileSafe(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function parseServerMounts(serverText) {
  const mounts = new Map();
  const pattern = /app\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*require\(\s*['"`]\.\/api\/([^'"`]+)['"`]\s*\)\s*\)/g;
  let match;
  while ((match = pattern.exec(serverText)) !== null) {
    const mountPath = match[1];
    const requirePath = match[2];
    const fileName = requirePath.endsWith('.js') ? requirePath : `${requirePath}.js`;
    mounts.set(fileName, mountPath);
  }
  return mounts;
}

function joinPaths(basePath, routePath) {
  if (!basePath) {
    return routePath || '';
  }
  const cleanBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const cleanRoute = routePath ? (routePath.startsWith('/') ? routePath : `/${routePath}`) : '';
  if (!cleanRoute || cleanRoute === '/') {
    return cleanBase;
  }
  return `${cleanBase}${cleanRoute}`;
}

function normalizePathParams(pathValue) {
  if (!pathValue) {
    return pathValue;
  }
  return pathValue
    .replace(/:([A-Za-z0-9_]+)/g, '{param}')
    .replace(/\{[^}]+\}/g, '{param}');
}

function parseRoutes(fileText) {
  const routes = [];
  const pattern = /router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
  let match;
  while ((match = pattern.exec(fileText)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      routePath: match[2]
    });
  }
  return routes;
}

function readOpenApiPaths(specText) {
  const paths = [];
  const lines = specText.split(/\r\n|\n/);
  for (const line of lines) {
    const match = line.match(/^\s{2}(\/[^:]+):\s*$/);
    if (match) {
      paths.push(match[1]);
    }
  }
  return paths;
}

function inferTag(fileName) {
  const map = {
    'ops.routes.js': 'ops',
    'opsTest.routes.js': 'ops',
    'deviceEvents.routes.js': 'device-events',
    'devices.routes.js': 'device-registry',
    'identityMappings.routes.js': 'identity-mappings',
    'employeesRegistry.routes.js': 'employees-registry',
    'attendance.routes.js': 'attendance',
    'simulate.routes.js': 'simulation',
    'simulation.routes.js': 'simulation',
    'policyProfiles.routes.js': 'policy-profiles',
    'companyProfile.routes.js': 'company-profile',
    'employeeAssignments.routes.js': 'employee-assignments',
    'employees.routes.js': 'employees',
    'ruleSets.routes.js': 'rule-sets',
    'resolutions.routes.js': 'resolutions',
    'resolutionsByDate.routes.js': 'resolutions',
    'system.routes.js': 'system'
  };
  return map[fileName] || 'misc';
}

function buildInventory() {
  const serverText = readFileSafe(serverPath);
  const mounts = parseServerMounts(serverText);
  const files = fs.readdirSync(apiDir).filter(name => name.endsWith('.routes.js'));
  const inventory = [];
  const ambiguous = [];

  files.forEach(fileName => {
    const fullPath = path.join(apiDir, fileName);
    const fileText = readFileSafe(fullPath);
    const basePath = mounts.get(fileName) || null;
    const routes = parseRoutes(fileText);
    if (!basePath) {
      ambiguous.push(fileName);
    }
    routes.forEach(route => {
      const fullPathValue = joinPaths(basePath, route.routePath);
      inventory.push({
        method: route.method,
        path: fullPathValue,
        normalizedPath: normalizePathParams(fullPathValue),
        sourceFile: `api/${fileName}`,
        basePath: basePath,
        routePath: route.routePath,
        tag: inferTag(fileName)
      });
    });
  });

  return { inventory, ambiguous };
}

function uniquePathsFromInventory(inventory) {
  const set = new Set();
  inventory.forEach(entry => {
    if (entry.normalizedPath) {
      set.add(entry.normalizedPath);
    }
  });
  return Array.from(set).sort();
}

function groupByTag(entries) {
  const grouped = {};
  entries.forEach(entry => {
    const tag = entry.tag || 'misc';
    if (!grouped[tag]) {
      grouped[tag] = [];
    }
    grouped[tag].push(entry);
  });
  Object.keys(grouped).forEach(tag => {
    grouped[tag].sort((a, b) => a.path.localeCompare(b.path));
  });
  return grouped;
}

function writeInventory(inventory) {
  ensureDir(outputDir);
  const payload = {
    generated_at: new Date().toISOString(),
    endpoints: inventory
  };
  fs.writeFileSync(inventoryPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function writeReport({ missingInSpec, extraInSpec, ambiguous }) {
  ensureDir(outputDir);
  const grouped = groupByTag(missingInSpec);
  const lines = [];
  lines.push('# OpenAPI Endpoint Inventory Report');
  lines.push('');
  lines.push('## Endpoints in code but missing in spec');
  if (missingInSpec.length === 0) {
    lines.push('- None');
  } else {
    Object.keys(grouped).sort().forEach(tag => {
      lines.push(`- ${tag}`);
      grouped[tag].forEach(entry => {
        lines.push(`  - ${entry.method} ${entry.path} (${entry.sourceFile})`);
      });
    });
  }
  lines.push('');
  lines.push('## Endpoints in spec but not found in code');
  if (extraInSpec.length === 0) {
    lines.push('- None');
  } else {
    extraInSpec.forEach(p => {
      lines.push(`- ${p}`);
    });
  }
  lines.push('');
  lines.push('## Ambiguous mounts');
  if (ambiguous.length === 0) {
    lines.push('- None');
  } else {
    ambiguous.forEach(fileName => {
      lines.push(`- ${fileName} (no mount found in server.js)`);
    });
  }
  lines.push('');
  fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');
}

function main() {
  const { inventory, ambiguous } = buildInventory();
  writeInventory(inventory);

  const specText = readFileSafe(specPath);
  const specPaths = readOpenApiPaths(specText);
  const codePaths = uniquePathsFromInventory(inventory);

  const specPathSet = new Set(specPaths.map(normalizePathParams));
  const codePathSet = new Set(codePaths);

  const missingInSpec = inventory.filter(entry => entry.normalizedPath && !specPathSet.has(entry.normalizedPath));
  const extraInSpec = specPaths.filter(p => !codePathSet.has(normalizePathParams(p)));

  writeReport({ missingInSpec, extraInSpec, ambiguous });
}

main();
