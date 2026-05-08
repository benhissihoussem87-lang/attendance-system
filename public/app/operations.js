import { request } from './apiClient.js';
import { activeCompanyId, state } from './state.js';
import { byId, esc, formatTime, rows } from './renderHelpers.js';
import {
  connection,
  deviceName,
  deviceSiteId,
  deviceSiteName,
  isProductReadyDevice,
  isProductSite,
  model,
  monitoringStatusLabel,
  productSafeErrorLabel,
  provider,
  resolveSelectedTimezone,
  resolveSelectedTimezoneInfo,
  rtPersistenceHealthSummary,
  liveSessionState,
  selectedAgentId,
  siteDisplayName,
  siteForDevice,
  syncStatusLabel
} from './policies.js';
import { closeSse, openSse, refreshRtRows } from './realtime.js';
import { hydrateCurrentMonitoringSession, hydrateMonitoringFromCommand } from './monitoring.js';

export function resolveExplorerState() {
  if (state.operationsErrors.sites) return 'sites load failed';
  if (state.operationsErrors.devices) return 'devices load failed';
  if (!state.devices.length) return 'no product-ready device';
  return 'ready';
}

export function resolveMonitoringState() {
  return state.operationsErrors.monitoring || monitoringStatusLabel(state.selectedDeviceMonitoringSession, state.selectedDeviceLiveProof);
}

export function resolveSyncState() {
  if (state.operationsErrors.sync) return state.operationsErrors.sync;
  return syncStatusLabel(state.selectedDeviceSyncState);
}

export function resolveLiveRowsState() {
  if (state.operationsErrors.realtime) return 'live punches unavailable';
  const sessionLiveState = liveSessionState(state.selectedDeviceRtRows, state.selectedDeviceMonitoringSession);
  if (!state.selectedDeviceRtRows.length) {
    return state.selectedDeviceMonitoringSession
      ? sessionLiveState.label
      : 'no live punches loaded';
  }
  return sessionLiveState.label;
}

function resetSelectedDeviceScopedState() {
  state.selectedDeviceMonitoringSession = null;
  state.selectedDeviceRtRows = [];
  state.selectedDeviceSyncState = null;
  state.selectedDeviceTechnicalDetails = { evidence: '', monitoring: '', sync: '' };
  state.selectedDeviceLiveProof = false;
  state.latestCommand = null;
  state.latestBatch = null;
  state.latestSync = null;
  state.operationsErrors.evidence = '';
  state.operationsErrors.realtime = '';
  state.operationsErrors.monitoring = '';
  state.operationsErrors.sync = '';
}

export async function selectDevice(deviceUid) {
  closeSse('Live connection stopped.');
  state.selectedDeviceUid = deviceUid || '';
  state.selectedDevice = state.devices.find(device => device.device_uid === state.selectedDeviceUid) || null;
  state.selectedSiteId = state.selectedDevice ? deviceSiteId(state.selectedDevice) : '';
  resetSelectedDeviceScopedState();
  renderDevices();
  renderSelectedDevice();
  await loadSelectedDeviceEvidence();
  await refreshRtRows();
  openSse();
}

export function renderDevices() {
  const body = byId('deviceTree');
  if (!state.devices.length) {
    const message = state.operationsErrors.devices || 'No product-ready device for this company.';
    body.innerHTML = '<div class="tree-empty">' + esc(message) + '</div>';
    state.selectedDevice = null;
    renderSelectedDevice();
    return;
  }

  const productSites = state.sites.filter(isProductSite);
  const siteBlocks = [];
  const rendered = new Set();
  productSites.forEach(site => {
    const devices = state.devices.filter(device => deviceSiteId(device) === site.site_id);
    if (!devices.length) return;
    devices.forEach(device => rendered.add(device.device_uid));
    siteBlocks.push(renderSiteBlock(siteDisplayName(site), devices, 'real-site'));
  });
  const unassigned = state.devices.filter(device => !rendered.has(device.device_uid));
  if (unassigned.length) {
    siteBlocks.push(renderSiteBlock('Unassigned devices', unassigned, 'fallback-site'));
  }
  body.innerHTML = siteBlocks.join('');
  body.querySelectorAll('button[data-device-uid]').forEach(button => {
    button.addEventListener('click', async () => {
      await selectDevice(button.getAttribute('data-device-uid'));
    });
  });
}

function renderSiteBlock(siteName, devices, mode) {
  return '<div class="tree-site" data-site-mode="' + esc(mode) + '">'
    + '<div class="tree-node site-node">'
    + '<span class="node-icon">▾</span>'
    + '<span>' + esc(siteName) + '</span>'
    + (mode === 'fallback-site' ? '<small>unassigned fallback</small>' : '')
    + '</div>'
    + devices.map(renderDeviceNode).join('')
    + '</div>';
}

function renderDeviceNode(device) {
  const c = connection(device);
  const selected = device.device_uid === state.selectedDeviceUid;
  return '<button type="button" class="tree-node device-node' + (selected ? ' selected' : '') + '" data-device-uid="' + esc(device.device_uid) + '">'
    + '<span class="node-icon">▣</span>'
    + '<span class="node-main">'
    + '<strong>' + esc(deviceName(device)) + '</strong>'
    + '<small>' + esc(model(device) || provider(device) || '-') + ' · ' + esc(c.host) + ':' + esc(c.port) + '</small>'
    + '</span>'
    + '<span class="node-state">' + esc(device.managed_status || '-') + '</span>'
    + '</button>';
}

export async function loadSites() {
  try {
    state.operationsErrors.sites = '';
    const data = await request('GET', '/api/agent-admin/sites', undefined, {
      company_id: activeCompanyId(),
      status: 'active',
      product_surface: 'true',
      limit: 200
    });
    state.sites = rows(data).filter(isProductSite);
  } catch (err) {
    state.sites = [];
    state.operationsErrors.sites = classifyError(err, 'Sites load failed');
  }
}

export async function loadDevices() {
  await loadSites();
  let data = null;
  try {
    state.operationsErrors.devices = '';
    data = await request('GET', '/api/devices', undefined, { company_id: activeCompanyId(), product_surface: 'true', limit: 500 });
  } catch (err) {
    state.devices = [];
    state.selectedDeviceUid = '';
    state.selectedDevice = null;
    state.operationsErrors.devices = classifyError(err, 'Devices load failed');
    resetSelectedDeviceScopedState();
    renderDevices();
    renderSelectedDevice();
    return;
  }
  const previousDeviceUid = state.selectedDeviceUid;
  state.devices = rows(data).filter(isProductReadyDevice);
  if (!state.devices.some(device => device.device_uid === state.selectedDeviceUid)) {
    state.selectedDeviceUid = state.devices[0] ? state.devices[0].device_uid : '';
  }
  state.selectedDevice = state.devices.find(device => device.device_uid === state.selectedDeviceUid) || null;
  state.selectedSiteId = state.selectedDevice ? deviceSiteId(state.selectedDevice) : '';
  if (previousDeviceUid !== state.selectedDeviceUid) {
    resetSelectedDeviceScopedState();
  }
  renderDevices();
  await loadSelectedDeviceEvidence();
}

export async function loadSelectedDeviceEvidence() {
  const device = state.selectedDevice;
  if (!device) {
    state.latestCommand = null;
    state.latestBatch = null;
    state.latestSync = null;
    renderSelectedDevice();
    return;
  }
  const companyId = activeCompanyId();
  const failures = [];
  try {
    const commands = await request('GET', '/api/agent-admin/commands', undefined, { company_id: companyId, device_uid: device.device_uid, limit: 10 });
    state.latestCommand = rows(commands)[0] || null;
  } catch (err) { state.latestCommand = null; failures.push(classifyError(err, 'latest command unavailable')); }
  try {
    const session = await hydrateCurrentMonitoringSession();
    if (!session && state.latestCommand) await hydrateMonitoringFromCommand(state.latestCommand);
  } catch (err) { failures.push(classifyError(err, 'monitoring session unavailable')); }
  try {
    const batches = await request('GET', '/api/agent-admin/device-event-batches', undefined, { company_id: companyId, device_uid: device.device_uid, limit: 5 });
    state.latestBatch = rows(batches)[0] || null;
  } catch (err) { state.latestBatch = null; failures.push(classifyError(err, 'latest batch unavailable')); }
  try {
    const sync = await request('GET', '/api/agent-admin/device-sync-states', undefined, { company_id: companyId, device_uid: device.device_uid, limit: 1 });
    state.latestSync = rows(sync)[0] || null;
  } catch (err) { state.latestSync = null; failures.push(classifyError(err, 'sync state unavailable')); }
  state.operationsErrors.evidence = failures.join('; ');
  state.selectedDeviceSyncState = state.latestBatch || state.latestCommand || state.latestSync || null;
  state.selectedDeviceTechnicalDetails.evidence = buildEvidenceTechnicalDetails();
  renderSelectedDevice();
}

export function renderSelectedDevice() {
  const detail = byId('deviceDetail');
  if (!state.selectedDevice) {
    detail.textContent = 'Select a product-ready pointeuse.';
    byId('breadcrumb').textContent = activeCompanyId() + ' / Site';
    byId('selectedObjectTitle').textContent = 'No device selected';
    byId('selectedObjectSubtitle').textContent = 'Add or bind a managed product-ready device to start operations.';
    byId('latestBatchState').textContent = 'No recent sync loaded.';
    byId('technicalState').textContent = 'No technical details loaded.';
    byId('syncState').textContent = 'sync idle';
    return;
  }
  const device = state.selectedDevice;
  const c = connection(device);
  const site = siteForDevice(device);
  const siteName = site ? siteDisplayName(site) : (deviceSiteName(device) || 'Unassigned devices');
  byId('breadcrumb').textContent = activeCompanyId() + ' / ' + siteName + ' / ' + deviceName(device);
  byId('selectedObjectTitle').textContent = deviceName(device);
  byId('selectedObjectSubtitle').textContent = (model(device) || provider(device) || 'Pointeuse') + ' · ' + c.host + ':' + c.port + ' · ' + (device.managed_status || 'status unknown');
  detail.innerHTML = '<dl>'
    + '<dt>Pointeuse</dt><dd>' + esc(deviceName(device)) + '</dd>'
    + '<dt>Model</dt><dd>' + esc(model(device) || provider(device) || '-') + '</dd>'
    + '<dt>Address</dt><dd>' + esc(c.host) + ':' + esc(c.port) + '</dd>'
    + '<dt>Site</dt><dd>' + esc(siteName) + '</dd>'
    + '<dt>Status</dt><dd>' + esc(device.managed_status || '-') + '</dd>'
    + '</dl>';
  byId('syncState').textContent = resolveSyncState();
  const rtPersistence = rtPersistenceHealthSummary(state.latestBatch);
  byId('latestBatchState').textContent = rtPersistence
    ? rtPersistence.label + ': events=' + rtPersistence.events_received_count + ', inserted=' + rtPersistence.inserted_count + '.'
    : (state.latestBatch ? 'Recent sync: ' + (state.latestBatch.status || '-') + ', inserted=' + (state.latestBatch.inserted_count || 0) + ', deduped=' + (state.latestBatch.deduped_count || 0) + '.' : 'No recent sync loaded.');
  byId('technicalState').textContent = buildTechnicalDetails();
}

function classifyError(err, fallback) {
  const message = err && err.message ? err.message : fallback;
  return productSafeErrorLabel(err || message, fallback);
}

function buildEvidenceTechnicalDetails() {
  const command = state.latestCommand ? 'Command: ' + (state.latestCommand.id || state.latestCommand.command_id || '-') + ' ' + (state.latestCommand.command_type || state.latestCommand.type || '-') + ' ' + (state.latestCommand.status || '-') : 'No latest command.';
  const batch = state.latestBatch ? 'Batch: ' + (state.latestBatch.id || state.latestBatch.batch_id || '-') + ' ' + (state.latestBatch.status || '-') + ', inserted=' + (state.latestBatch.inserted_count || 0) + ', deduped=' + (state.latestBatch.deduped_count || 0) : 'No latest batch.';
  const sync = state.latestSync ? 'Sync: ' + (state.latestSync.status || '-') + (state.latestSync.last_sync_completed_at ? ' completed ' + formatTime(state.latestSync.last_sync_completed_at, resolveSelectedTimezone()) : '') : 'No sync state.';
  const failures = state.operationsErrors.evidence ? 'Evidence warnings: ' + state.operationsErrors.evidence + '.' : '';
  const rtPersistence = rtPersistenceHealthSummary(state.latestBatch);
  const rtPersistenceDetail = rtPersistence
    ? rtPersistence.label + ': events=' + rtPersistence.events_received_count
      + ', inserted=' + rtPersistence.inserted_count
      + ', skip=' + (rtPersistence.skip_reason || '-') + '.'
    : '';
  return [command, batch, rtPersistenceDetail, sync, failures].filter(Boolean).join(' ');
}

function buildTechnicalDetails() {
  if (!state.selectedDevice) return 'No technical details loaded.';
  const timezoneInfo = resolveSelectedTimezoneInfo();
  return [
    'Device UID: ' + state.selectedDevice.device_uid + '.',
    'Agent: ' + selectedAgentId() + '.',
    'Timezone: ' + timezoneInfo.timeZone + ' (' + timezoneInfo.source + ').',
    state.selectedDeviceTechnicalDetails.evidence,
    state.selectedDeviceTechnicalDetails.monitoring,
    state.selectedDeviceTechnicalDetails.sync
  ].filter(Boolean).join(' ');
}
