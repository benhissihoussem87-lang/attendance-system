import { request } from './apiClient.js';
import { activeCompanyId, state } from './state.js';
import { byId } from './renderHelpers.js';
import { productSafeErrorLabel, resolveSelectedTimezone, selectedAgentId, technicalErrorDetails } from './policies.js';
import { loadSelectedDeviceEvidence, resolveSyncState } from './operations.js';
import { hasRole } from './auth.js';

export async function syncHistory(options = {}) {
  if (!hasRole('operator')) throw new Error('insufficient_role');
  if (!state.selectedDevice) throw new Error('Select a product-ready pointeuse first');
  const retryAfterCapabilityRefresh = options.retryAfterCapabilityRefresh !== false;
  const agentId = selectedAgentId();
  state.operationsErrors.sync = '';
  state.selectedDeviceSyncState = { status: 'running' };
  byId('syncState').textContent = resolveSyncState();
  let command;
  try {
    command = await request('POST', '/api/agent-admin/agents/' + encodeURIComponent(agentId) + '/commands/pull-device-events', {
      company_id: activeCompanyId(),
      device_uid: state.selectedDevice.device_uid,
      options: { history_mode: 'history_drain', device_timezone: resolveSelectedTimezone(), max_events: 500 }
    });
  } catch (err) {
    if (!retryAfterCapabilityRefresh || !isStalePullDevicePathCapability(err)) {
      throw err;
    }
    state.selectedDeviceSyncState = { status: 'running', capability_refresh: 'running' };
    byId('syncState').textContent = 'sync running';
    await refreshPullDevicePathCapability(agentId);
    return syncHistory({ retryAfterCapabilityRefresh: false });
  }
  state.latestCommand = command;
  state.selectedDeviceSyncState = command;
  state.selectedDeviceTechnicalDetails.sync = 'Sync command: ' + (command.id || command.command_id || '-') + ' (' + (command.status || 'queued') + ').';
  byId('syncState').textContent = resolveSyncState();
  await loadSelectedDeviceEvidence();
}

async function refreshPullDevicePathCapability(agentId) {
  const refreshCommand = await request(
    'POST',
    '/api/agent-admin/agents/' + encodeURIComponent(agentId) + '/commands/refresh-device-path-pull-capability',
    {
      company_id: activeCompanyId(),
      device_uid: state.selectedDevice.device_uid,
      options: {
        device_timezone: resolveSelectedTimezone(),
        max_events: 1
      }
    }
  );
  state.selectedDeviceTechnicalDetails.sync = 'Pull capability refresh command: '
    + (refreshCommand.id || refreshCommand.command_id || '-')
    + ' (' + (refreshCommand.status || 'queued') + ').';
  const settled = await waitForCommand(refreshCommand.id || refreshCommand.command_id, agentId);
  const result = settled && settled.result_payload && settled.result_payload.capability_refresh
    ? settled.result_payload.capability_refresh
    : null;
  if (!settled || settled.status !== 'acknowledged' || !result || result.ok !== true) {
    const reason = result && result.reason_code ? result.reason_code : (settled && settled.failure_reason ? settled.failure_reason : 'device_path_capability_refresh_failed');
    throw new Error(reason);
  }
}

async function waitForCommand(commandId, agentId) {
  if (!commandId) return null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    const response = await request('GET', '/api/agent-admin/commands', undefined, {
      company_id: activeCompanyId(),
      agent_id: agentId,
      device_uid: state.selectedDevice.device_uid,
      limit: 20
    });
    const rows = Array.isArray(response && response.value) ? response.value : [];
    const row = rows.find(item => item && item.id === commandId);
    if (row && ['acknowledged', 'failed', 'expired'].includes(String(row.status || '').toLowerCase())) {
      return row;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('device_path_capability_refresh_timeout');
}

function isStalePullDevicePathCapability(err) {
  const details = err && err.details ? err.details : {};
  const gate = details.execution_gate || {};
  return details.error === 'device_path_capability_unknown'
    && gate.required_device_capability_key === 'device_path.pull_device_events'
    && gate.device_path_capability_reason === 'reported_state_stale';
}

export function bindSync() {
  byId('syncHistory').addEventListener('click', async () => {
    const btn = byId('syncHistory');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      await syncHistory();
    } catch (err) {
      state.operationsErrors.sync = productError(err);
      state.selectedDeviceTechnicalDetails.sync = technicalErrorDetails(err);
      byId('syncState').textContent = resolveSyncState();
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  });
}

function productError(err) {
  const message = err && err.message ? err.message : 'Sync failed';
  const label = productSafeErrorLabel(err || message, 'Sync failed');
  return label === message ? 'sync failed: ' + label : label;
}
