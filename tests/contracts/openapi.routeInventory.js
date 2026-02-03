const path = require('path');
const express = require('express');
const { toBool } = require('../../services/envBool');

function joinPaths(prefix, routePath) {
  if (!prefix) return routePath || '';
  if (!routePath || routePath === '/') return prefix;
  if (prefix.endsWith('/') && routePath.startsWith('/')) {
    return prefix.slice(0, -1) + routePath;
  }
  if (!prefix.endsWith('/') && !routePath.startsWith('/')) {
    return `${prefix}/${routePath}`;
  }
  return prefix + routePath;
}

function normalizePath(pathString) {
  if (!pathString) return pathString;
  return pathString.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    const normalized = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    return `{${normalized}}`;
  });
}

function collectRoutesFromRouter(router, prefix) {
  const routes = [];
  if (!router || !router.stack) {
    return routes;
  }

  router.stack.forEach(layer => {
    if (layer.route && layer.route.path) {
      const methods = Object.keys(layer.route.methods || {})
        .filter(method => layer.route.methods[method])
        .map(method => method.toUpperCase());
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      paths.forEach(routePath => {
        methods.forEach(method => {
          routes.push({
            method,
            path: normalizePath(joinPaths(prefix, routePath))
          });
        });
      });
      return;
    }

    if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      const nestedPrefix = layer.path ? joinPaths(prefix, layer.path) : prefix;
      routes.push(...collectRoutesFromRouter(layer.handle, nestedPrefix));
    }
  });

  return routes;
}

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  if (!process.env.PGHOST) process.env.PGHOST = 'localhost';
  if (!process.env.PGUSER) process.env.PGUSER = 'postgres';
  if (!process.env.PGDATABASE) process.env.PGDATABASE = 'attendance';

  const mounts = [
    ['/api/system', require('../../api/system.routes')],
    ['/api/employees', require('../../api/employees.routes')],
    ['/api/rule-sets', require('../../api/ruleSets.routes')],
    ['/api/attendance', require('../../api/attendance.routes')],
    ['/api', require('../../api/resolutions.routes')],
    ['/api/simulate', require('../../api/simulate.routes')],
    ['/api/simulation', require('../../api/simulation.routes')],
    ['/api/device-events', require('../../api/deviceEvents.routes')],
    ['/api/devices', require('../../api/devices.routes')],
    ['/api/ops', require('../../api/ops.routes')],
    ['/api/policy-profiles', require('../../api/policyProfiles.routes')],
    ['/api/resolutions', require('../../api/resolutionsByDate.routes')],
    ['/api/company-profile', require('../../api/companyProfile.routes')],
    ['/api/employees-registry', require('../../api/employeesRegistry.routes')],
    ['/api/identity-mappings', require('../../api/identityMappings.routes')],
    ['/api/employee-assignments', require('../../api/employeeAssignments.routes')]
  ];

  if (toBool(process.env.ALLOW_TEST_ENDPOINTS)) {
    mounts.push(['/api/ops/test', require('../../api/opsTest.routes')]);
  }

  mounts.forEach(([prefix, router]) => {
    app.use(prefix, router);
  });

  return { app, mounts };
}

function listApiRoutes() {
  const { mounts } = buildApp();
  const routes = [];
  mounts.forEach(([prefix, router]) => {
    routes.push(...collectRoutesFromRouter(router, prefix));
  });
  return routes;
}

module.exports = {
  listApiRoutes,
  normalizePath
};
