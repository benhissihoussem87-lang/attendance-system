import { appUrl } from './apiClient.js';
import { request } from './apiClient.js';
import { activeCompanyId, state } from './state.js';
import { byId, esc, formatTime, rows } from './renderHelpers.js';
import {
  getLatestCurrentSessionRtRow,
  getLatestHistoricalRtRow,
  getRtRowSavedAt,
  liveSessionState,
  productSafeErrorLabel,
  resolveSelectedTimezone,
  rtPersonLabel,
  rtPrimaryDisplayTime,
  rtSourceLabel,
  rtUntrustedObservedTimeLabel
} from './policies.js';
import { renderMonitoring } from './monitoring.js';

function mergeRt(newRows) {
  const scopedRows = newRows.filter(rowBelongsToSelectedDevice);
  const seen = new Set(state.selectedDeviceRtRows.map(row => row.id || row.observation_id || JSON.stringify(row)));
  scopedRows.forEach(row => {
    const key = row.id || row.observation_id || JSON.stringify(row);
    if (!seen.has(key)) {
      seen.add(key);
      state.selectedDeviceRtRows.unshift(row);
    }
  });
  state.selectedDeviceRtRows = state.selectedDeviceRtRows.slice(0, 50);
  updateLiveProofFromRows();
  renderRtRows();
  renderMonitoring();
}

export function updateLiveProofFromRows() {
  const sessionState = liveSessionState(state.selectedDeviceRtRows, state.selectedDeviceMonitoringSession);
  state.selectedDeviceLiveProof = sessionState.hasCurrentSessionProof;
  return sessionState;
}

function latestLiveSummary() {
  const timeZone = resolveSelectedTimezone();
  const sessionState = liveSessionState(state.selectedDeviceRtRows, state.selectedDeviceMonitoringSession);
  const currentRow = getLatestCurrentSessionRtRow(state.selectedDeviceRtRows, state.selectedDeviceMonitoringSession);
  const historicalRow = getLatestHistoricalRtRow(state.selectedDeviceRtRows, state.selectedDeviceMonitoringSession);
  const parts = [sessionState.label + '.'];
  if (currentRow) {
    parts.push('Latest saved live punch: ' + formatTime(getRtRowSavedAt(currentRow), timeZone) + '.');
  } else if (historicalRow) {
    parts.push('Latest saved live punch: ' + formatTime(getRtRowSavedAt(historicalRow), timeZone) + '.');
    if (sessionState.state === 'old_live_punches_only') {
      parts.push('No new live punch saved in this session.');
    }
  }
  if (
    state.selectedDeviceMonitoringSession
    && !sessionState.hasCurrentSessionProof
    && (sessionState.state === 'waiting_for_new_live_punch' || sessionState.state === 'old_live_punches_only')
  ) {
    parts.push('If the device was used, run Sync attendance logs to verify full-history events.');
  }
  return parts.join(' ');
}

function rowBelongsToSelectedDevice(row) {
  if (!state.selectedDevice) return false;
  const rowDeviceUid = row.device_uid || row.deviceUid || row.device_id || row.deviceId || '';
  return !rowDeviceUid || rowDeviceUid === state.selectedDevice.device_uid;
}

export function renderRtRows() {
  const body = byId('rtBody');
  updateLiveProofFromRows();
  if (!state.selectedDeviceRtRows.length) {
    body.innerHTML = '<tr><td colspan="5">' + esc(state.operationsErrors.realtime || 'No live punches loaded.') + '</td></tr>';
    return;
  }
  const timeZone = resolveSelectedTimezone();
  body.innerHTML = state.selectedDeviceRtRows.map(row => {
    const untrustedObservedTime = rtUntrustedObservedTimeLabel(row);
    const isCurrent = liveSessionState([row], state.selectedDeviceMonitoringSession).hasCurrentSessionProof;
    return '<tr>'
    + '<td>' + esc(formatTime(rtPrimaryDisplayTime(row), timeZone))
    + (untrustedObservedTime
      ? '<br><small>Untrusted device time: ' + esc(untrustedObservedTime) + '</small>'
      : '')
    + '</td>'
    + '<td>' + esc(rtPersonLabel(row)) + '</td>'
    + '<td>' + esc(row.direction_provisional || row.direction || '-') + '</td>'
    + '<td>' + esc(row.rt_state_code || '-') + '</td>'
    + '<td>' + esc(isCurrent ? 'current session' : 'history') + '<br><small>' + esc(rtSourceLabel(row)) + '</small></td>'
    + '</tr>';
  }).join('');
}

export async function refreshRtRows() {
  if (!state.selectedDevice) return;
  try {
    state.operationsErrors.realtime = '';
    const data = await request('GET', '/api/agent-admin/devices/' + encodeURIComponent(state.selectedDevice.device_uid) + '/realtime-observations', undefined, { company_id: activeCompanyId(), limit: 20 });
    mergeRt(rows(data).reverse());
    byId('sseState').textContent = latestLiveSummary();
  } catch (err) {
    if (err && err.sessionExpired) return;
    state.operationsErrors.realtime = classifyRealtimeError(err);
    renderRtRows();
    renderMonitoring();
    byId('sseState').textContent = state.operationsErrors.realtime;
  }
}

export function openSse() {
  if (!state.selectedDevice) return;
  closeSse('Connecting live punches...');
  const streamUrl = appUrl('/api/agent-admin/devices/' + encodeURIComponent(state.selectedDevice.device_uid) + '/realtime-observations/stream', { company_id: activeCompanyId() });
  try {
    state.sse = new EventSource(streamUrl);
    const handleObservationEvent = event => {
      try {
        mergeRt([JSON.parse(event.data)]);
        byId('sseState').textContent = latestLiveSummary();
      } catch (_) {
        byId('sseState').textContent = 'Live update failed. Use refresh.';
      }
    };
    state.sse.onopen = () => {
      byId('sseState').textContent = state.selectedDeviceMonitoringSession
        ? 'Observation stream connected. ' + latestLiveSummary()
        : 'Observation stream open; monitoring not active.';
    };
    state.sse.onerror = () => { byId('sseState').textContent = 'Live connection unavailable. Use refresh.'; };
    state.sse.onmessage = handleObservationEvent;
    state.sse.addEventListener('rt_observation', handleObservationEvent);
  } catch (_) {
    byId('sseState').textContent = 'Live connection unavailable. Use refresh.';
  }
}

export function closeSse(message) {
  if (state.sse) state.sse.close();
  state.sse = null;
  byId('sseState').textContent = message || 'Live connection stopped.';
}

export function bindRealtime() {
  byId('refreshRt').addEventListener('click', () => refreshRtRows());
}

function classifyRealtimeError(err) {
  const message = err && err.message ? err.message : 'RT observations load failed';
  const label = productSafeErrorLabel(err || message, 'RT observations load failed');
  return label === message ? 'RT observations load failed: ' + label : label;
}
