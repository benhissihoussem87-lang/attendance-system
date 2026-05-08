import { request } from './apiClient.js';
import { activeCompanyId, state } from './state.js';
import { byId } from './renderHelpers.js';
import { isMonitoringSessionExpired, monitoringStatusLabel, productSafeErrorLabel, technicalErrorDetails } from './policies.js';
import { closeSse, openSse } from './realtime.js';
import { hasRole } from './auth.js';

export function renderMonitoring() {
  const session = state.selectedDeviceMonitoringSession;
  byId('monitoringState').textContent = state.operationsErrors.monitoring || monitoringStatusLabel(session, state.selectedDeviceLiveProof);
  state.selectedDeviceTechnicalDetails.monitoring = session
    ? 'Session: ' + (session.id || session.session_id || '-')
      + '. Start command: ' + (session.start_command_id || '-')
      + '. Stop command: ' + (session.stop_command_id || '-') + '.'
    : 'No monitoring session.';
  renderTechnicalDetails();
}

export async function hydrateCurrentMonitoringSession() {
  if (!state.selectedDevice) return null;
  const session = await request(
    'GET',
    '/api/agent-admin/devices/' + encodeURIComponent(state.selectedDevice.device_uid) + '/monitoring-sessions/current',
    undefined,
    { company_id: activeCompanyId() }
  );
  state.selectedDeviceMonitoringSession = sessionBelongsToSelectedDevice(session) ? session : null;
  renderMonitoring();
  return state.selectedDeviceMonitoringSession;
}

export async function connectMonitoring() {
  if (!hasRole('operator')) throw new Error('insufficient_role');
  if (!state.selectedDevice) throw new Error('Select a product-ready pointeuse first');
  state.operationsErrors.monitoring = '';
  byId('monitoringState').textContent = 'connecting';
  state.selectedDeviceMonitoringSession = await request('POST', '/api/agent-admin/devices/' + encodeURIComponent(state.selectedDevice.device_uid) + '/monitoring-sessions', {
    company_id: activeCompanyId(),
    rt_enabled: true,
    lease_ttl_seconds: 300
  });
  renderMonitoring();
  await pollMonitoring(['active', 'failed'], 15);
  openSse();
}

export async function refreshMonitoring() {
  if (!state.selectedDeviceMonitoringSession) return null;
  const sessionId = state.selectedDeviceMonitoringSession.id || state.selectedDeviceMonitoringSession.session_id;
  const session = await request('GET', '/api/agent-admin/device-monitoring-sessions/' + encodeURIComponent(sessionId), undefined, { company_id: activeCompanyId() });
  state.selectedDeviceMonitoringSession = sessionBelongsToSelectedDevice(session) ? session : null;
  renderMonitoring();
  return state.selectedDeviceMonitoringSession;
}

export async function hydrateMonitoringFromCommand(command) {
  const result = command
    && command.result_payload
    && command.result_payload.monitoring_command_result;
  const sessionId = result && result.monitoring_session_id;
  if (!sessionId || !state.selectedDevice) return null;
  if (result.device_uid && result.device_uid !== state.selectedDevice.device_uid) return null;
  const session = await request('GET', '/api/agent-admin/device-monitoring-sessions/' + encodeURIComponent(sessionId), undefined, { company_id: activeCompanyId() });
  state.selectedDeviceMonitoringSession = sessionBelongsToSelectedDevice(session) ? session : null;
  renderMonitoring();
  return state.selectedDeviceMonitoringSession;
}

async function pollMonitoring(finalStates, attempts) {
  for (let index = 0; index < attempts; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const session = await refreshMonitoring();
    if (session && finalStates.includes(session.status)) return session;
  }
  return state.selectedDeviceMonitoringSession;
}

export async function disconnectMonitoring() {
  if (!hasRole('operator')) throw new Error('insufficient_role');
  if (!state.selectedDeviceMonitoringSession) throw new Error('No monitoring session to stop');
  state.operationsErrors.monitoring = '';
  byId('monitoringState').textContent = 'stopping';
  const sessionId = state.selectedDeviceMonitoringSession.id || state.selectedDeviceMonitoringSession.session_id;
  state.selectedDeviceMonitoringSession = await request('DELETE', '/api/agent-admin/device-monitoring-sessions/' + encodeURIComponent(sessionId), {
    company_id: activeCompanyId(),
    stop_reason: 'operator_stop'
  });
  renderMonitoring();
  closeSse('Live connection stopped.');
  await pollMonitoring(['stopped', 'failed', 'expired'], 15);
}

export function bindMonitoring() {
  byId('connectMonitoring').addEventListener('click', () => connectMonitoring().catch(err => {
    state.operationsErrors.monitoring = productError('Connect failed', err);
    state.selectedDeviceTechnicalDetails.monitoringError = technicalErrorDetails(err);
    renderMonitoring();
  }));
  byId('disconnectMonitoring').addEventListener('click', () => disconnectMonitoring().catch(err => {
    state.operationsErrors.monitoring = productError('Disconnect failed', err);
    state.selectedDeviceTechnicalDetails.monitoringError = technicalErrorDetails(err);
    renderMonitoring();
  }));
}

function sessionBelongsToSelectedDevice(session) {
  if (!session || !state.selectedDevice) return false;
  const sessionDeviceUid = session.device_uid || session.deviceUid || session.device_id || session.deviceId || '';
  return !sessionDeviceUid || sessionDeviceUid === state.selectedDevice.device_uid;
}

function productError(prefix, err) {
  const message = err && err.message ? err.message : prefix;
  const label = productSafeErrorLabel(err || message, prefix);
  return label === message ? prefix + ': ' + label : label;
}

function renderTechnicalDetails() {
  const session = state.selectedDeviceMonitoringSession;
  const leaseState = session && isMonitoringSessionExpired(session)
    ? 'Monitoring lease expired.'
    : '';
  byId('technicalState').textContent = [
    state.selectedDevice ? 'Device UID: ' + state.selectedDevice.device_uid + '.' : '',
    state.selectedDeviceTechnicalDetails.evidence,
    leaseState,
    state.selectedDeviceTechnicalDetails.monitoring,
    state.selectedDeviceTechnicalDetails.monitoringError,
    state.selectedDeviceTechnicalDetails.sync
  ].filter(Boolean).join(' ') || 'No technical details loaded.';
}
