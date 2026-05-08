const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readText(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

function run() {
  const html = readText('public/boss/index.html');
  const appJs = readText('public/boss/app.js');

  assert.ok(
    html.includes('id="devicesLifecycleScope"'),
    'boss devices filter must expose lifecycle scope selector'
  );
  assert.ok(
    html.includes('SaaS Device Operations'),
    'boss shell should present product-grade SaaS operations heading'
  );
  assert.ok(
    html.includes('metricRuntimesOfflineOverview')
      && html.includes('Needs Attention')
      && html.includes('Recent Health Signals')
      && html.includes('overviewSignalsBody'),
    'boss overview should surface attention-first runtime/device health signals'
  );
  assert.ok(
    html.includes('data-tab="activity"')
      && html.includes('Sites &amp; Agents')
      && html.includes('Device Live View'),
    'boss navigation/IA should expose Overview, Sites & Agents, Devices, and Activity with device live view'
  );
  assert.ok(
    html.includes('class="devices-table"')
      && html.includes('Pull Readiness')
      && html.includes('Last Successful Pull')
      && html.includes('Next Action'),
    'boss devices list should present onboarding/readiness-oriented product columns'
  );
  assert.ok(
    html.includes('Site Runtimes')
      && html.includes('metricRuntimesOnline')
      && html.includes('Devices Attached')
      && html.includes('Requires Attention'),
    'boss agents area should present site-runtime health and relationship framing'
  );
  assert.ok(
    html.includes('value="bridge_ops" selected'),
    'boss devices scope selector must default to bridge_ops'
  );
  assert.ok(
    html.includes('value="all"'),
    'boss devices scope selector must preserve diagnostic all scope'
  );
  assert.ok(
    html.includes('value="ingest_only"'),
    'boss devices scope selector must preserve ingest_only diagnostic scope'
  );
  assert.ok(
    appJs.includes("lifecycle_scope: lifecycleScopeFilter === 'all' ? '' : lifecycleScopeFilter"),
    'boss devices loader must send lifecycle_scope filter with all-scope passthrough'
  );
  assert.ok(
    appJs.includes("actionType: 'claim_candidate'"),
    'boss progress action model must include claim action for candidates'
  );
  assert.ok(
    appJs.includes("actionType: 'validate_candidate'"),
    'boss progress action model must include validate action for configurable candidates'
  );
  assert.ok(
    appJs.includes("actionType: 'bind_managing_agent'"),
    'boss progress action model must include bind action for managed-unbound devices'
  );
  assert.ok(
    appJs.includes("actionType: 'queue_pull'"),
    'boss progress action model must include queue action for managed devices'
  );
  assert.ok(
    html.includes('id="onboardingAgentId"'),
    'boss device live view must expose agent selection input for validate/bind actions'
  );
  assert.ok(
    appJs.includes('/onboarding-readiness'),
    'boss progress evidence loader must read onboarding-readiness endpoint'
  );
  assert.ok(
    appJs.includes('loadDevicesReadinessMap')
      && appJs.includes('loadDeviceActivitySummaryMap')
      && appJs.includes('device-select-btn'),
    'boss devices experience should derive per-device readiness/activity summaries and support explicit device selection'
  );
  assert.ok(
    appJs.includes('resolveDeviceRuntimeAgentId')
      && appJs.includes('metricRuntimesOnline')
      && appJs.includes('Site runtime offline'),
    'boss agents runtime view should connect device attachment and runtime health state'
  );
  assert.ok(
    appJs.includes('classifyRuntimeHealth')
      && appJs.includes('Site runtime degraded')
      && appJs.includes('recentFailures24h'),
    'boss agents runtime view should classify runtime health and recent failure pressure'
  );
  assert.ok(
    appJs.includes('deriveDeviceOperationalHealth')
      && appJs.includes('Latest failure:')
      && html.includes('Degraded / Failed Signals'),
    'boss devices view should distinguish blocked/degraded/healthy states with recent failure context'
  );
  assert.ok(
    appJs.includes('/api/agent-admin/devices/')
      && appJs.includes('/validate'),
    'boss candidate validation action must call validation queue endpoint'
  );
  assert.ok(
    appJs.includes('/managing-agent-binding'),
    'boss managed-unbound action must call managing-agent-binding endpoint'
  );
  assert.ok(
    appJs.includes('/api/agent-admin/discovered-devices/') && appJs.includes('/claim'),
    'boss candidate action must call discovered-device claim endpoint'
  );
  assert.ok(
    appJs.includes('device_managing_agent_binding_missing')
      && appJs.includes('device_managing_agent_binding_conflict'),
    'boss queue action must surface explicit binding error reasons'
  );
  assert.ok(
    appJs.includes('function evaluatePullCommandProgress'),
    'boss live view must evaluate command progress using recency evidence'
  );
  assert.ok(
    appJs.includes('stale queued command no longer blocks readiness'),
    'boss live view must prevent stale queued commands from forcing pull-in-progress state'
  );

  console.log('boss devices operational coherence contract tests passed');
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
