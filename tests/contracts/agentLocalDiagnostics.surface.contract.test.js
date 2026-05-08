const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readText(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

function run() {
  const html = readText('agent/public/diagnostics/index.html');
  const appJs = readText('agent/public/diagnostics/app.js');
  const agentIndex = readText('agent/index.js');
  const serverModule = readText('agent/lib/localDiagnosticsServer.js');

  assert.ok(
    html.includes('Local Agent Diagnostics')
      && html.includes('Agent Status')
      && html.includes('Devices (Local Runtime View)')
      && html.includes('Recent Activity')
      && html.includes('Health &amp; Recent History')
      && html.includes('Failure Pattern'),
    'local diagnostics UI should expose status, history, devices, and recent activity sections'
  );
  assert.ok(
    html.includes('SaaS <code>/boss</code> remains the primary control plane.'),
    'local diagnostics UI should explicitly frame /boss as primary control plane'
  );
  assert.ok(
    appJs.includes("fetch('/api/local-diagnostics'"),
    'local diagnostics UI should read from the local diagnostics JSON endpoint'
  );
  assert.ok(
    appJs.includes('deriveHealthLevel')
      && appJs.includes('buildHistorySummary')
      && appJs.includes('Repeating failure')
      && appJs.includes('Historical residue'),
    'local diagnostics UI should classify health and clarify whether failures are repeating or historical'
  );
  assert.ok(
    serverModule.includes('/api/local-diagnostics')
      && serverModule.includes('/diagnostics')
      && serverModule.includes('127.0.0.1'),
    'local diagnostics server should expose diagnostics API/UI routes on local-first defaults'
  );
  assert.ok(
    agentIndex.includes('AGENT_DIAGNOSTICS_ENABLED')
      && agentIndex.includes('startLocalDiagnosticsServer')
      && agentIndex.includes('diagnosticsTracker.buildSnapshot'),
    'agent runtime should wire diagnostics config, server startup, and snapshot provider'
  );

  console.log('agent local diagnostics surface contract tests passed');
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
