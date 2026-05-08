import { request } from './apiClient.js';
import { activeCompanyId, state, storage } from './state.js';
import { byId, esc, formatTime, rows, setStatus, text } from './renderHelpers.js';
import { loadDevices } from './operations.js';
import { connection, deviceName, deviceSiteId, isProductAgent, isProductReadyDevice, model, provider, resolveSelectedTimezone, siteDisplayName } from './policies.js';
import { closeSse, openSse, refreshRtRows } from './realtime.js';
import { hasRole } from './auth.js';

function companyIdOf(company) {
  return company.company_id || company.id || '';
}

function companyName(company) {
  return company.display_name || company.name || companyIdOf(company);
}

function agentLabel(agent) {
  if (!agent) return '-';
  const version = agent.agent_reported_version || agent.agent_version || '-';
  return (agent.agent_name || agent.id || '-') + ' · ' + (agent.status || '-') + ' · v' + version;
}

function siteOptions(selectedSiteId = '') {
  const options = ['<option value="">Unassigned</option>'];
  state.sites.forEach(site => {
    options.push('<option value="' + esc(site.site_id) + '"' + (site.site_id === selectedSiteId ? ' selected' : '') + '>'
      + esc(siteDisplayName(site)) + '</option>');
  });
  return options.join('');
}

function agentOptions(selectedAgentId = '') {
  const options = ['<option value="">No agent selected</option>'];
  state.agents.forEach(agent => {
    options.push('<option value="' + esc(agent.id) + '"' + (agent.id === selectedAgentId ? ' selected' : '') + '>'
      + esc(agentLabel(agent)) + '</option>');
  });
  return options.join('');
}

function siteTimezone(site) {
  const metadata = site && typeof site.metadata === 'object' && site.metadata ? site.metadata : {};
  return text(metadata.timezone || site.timezone || '').trim();
}

function readinessFor(deviceUid) {
  return state.deviceReadiness[deviceUid] || null;
}

function activeBindingAgentId(device) {
  const readiness = readinessFor(device.device_uid);
  return readiness && readiness.active_binding ? readiness.active_binding.agent_id : '';
}

function capabilitySummary(readiness) {
  const reported = readiness && readiness.reported_state ? readiness.reported_state : null;
  if (!reported) return 'No device path capability state loaded.';
  const capability = reported.capability_key || reported.required_device_capability_key || 'device_path.pull_device_events';
  const status = reported.capability_status || reported.status || reported.device_path_capability_status || 'unknown';
  const reason = reported.capability_reason || reported.reason || reported.device_path_capability_reason || '';
  const reportedAt = reported.reported_at ? ', reported ' + formatTime(reported.reported_at, resolveSelectedTimezone()) : '';
  return capability + ': ' + status + (reason ? ' (' + reason + ')' : '') + reportedAt + '.';
}

export function renderCompanies() {
  const select = byId('companySelect');
  select.innerHTML = state.companies.map(company => {
    const id = companyIdOf(company);
    return '<option value="' + esc(id) + '">' + esc(companyName(company)) + ' (' + esc(id) + ')</option>';
  }).join('');
  const saved = localStorage.getItem(storage.companyId) || 'DEFAULT';
  if (state.companies.some(company => companyIdOf(company) === saved)) select.value = saved;
  if (!select.value && state.companies[0]) select.value = companyIdOf(state.companies[0]);
  localStorage.setItem(storage.companyId, activeCompanyId());
  select.disabled = true;
  byId('companyState').textContent = state.companies.length ? 'Context: ' + activeCompanyId() + '.' : 'No companies found.';
  byId('companyTreeLabel').textContent = state.companies.length ? activeCompanyId() : 'Company';
  renderCompanyList();
}

function renderCompanyList() {
  const target = byId('companyList');
  if (!target) return;
  if (!state.companies.length) {
    target.textContent = 'No companies loaded.';
    return;
  }
  target.innerHTML = '<dl>' + state.companies.map(company => {
    const active = companyIdOf(company) === activeCompanyId() ? 'active context' : (company.is_active === false ? 'inactive' : 'available');
    return '<dt>' + esc(companyName(company)) + '</dt><dd>'
      + esc(companyIdOf(company))
      + ' · timezone ' + esc(company.timezone || '-')
      + ' · ' + esc(active)
      + '</dd>';
  }).join('') + '</dl>';
}

export function renderSites() {
  const siteState = byId('siteState');
  if (!siteState) return;
  if (!state.sites.length) {
    siteState.textContent = 'No active product sites loaded. Unassigned product-ready devices stay visible under Unassigned devices.';
    renderSiteList();
    renderDeviceSiteAssignmentState();
    renderDeviceFormOptions();
    return;
  }
  const errorSuffix = state.settingsErrors.siteAgents ? ' Agent status partial: ' + state.settingsErrors.siteAgents + '.' : '';
  siteState.textContent = 'Active sites: ' + state.sites.map(site => siteDisplayName(site)).join(', ') + '.' + errorSuffix;
  renderSiteList();
  renderDeviceSiteAssignmentState();
  renderDeviceFormOptions();
}

function renderSiteList() {
  const target = byId('siteList');
  if (!target) return;
  if (!state.sites.length) {
    target.textContent = 'No sites loaded.';
    return;
  }
  target.innerHTML = state.sites.map(site => {
    const activeAgent = state.siteActiveAgents[site.site_id];
    const lease = activeAgent && activeAgent.active_lease ? activeAgent.active_lease : null;
    const agentId = lease && lease.agent_id ? lease.agent_id : '';
    return '<section class="settings-row" data-site-id="' + esc(site.site_id) + '">'
      + '<h4>' + esc(siteDisplayName(site)) + '</h4>'
      + '<label>Site name <input data-site-name value="' + esc(site.site_name || '') + '" /></label>'
      + '<label>Timezone <input data-site-timezone value="' + esc(siteTimezone(site) || 'Africa/Tunis') + '" /></label>'
      + '<label>Status <select data-site-status>'
      + '<option value="active"' + (site.status === 'active' ? ' selected' : '') + '>active</option>'
      + '<option value="inactive"' + (site.status === 'inactive' ? ' selected' : '') + '>inactive</option>'
      + '</select></label>'
      + '<label>Active agent <select data-site-agent>' + agentOptions(agentId) + '</select></label>'
      + '<p class="muted-line">Current active agent: ' + esc(agentId || 'none') + '</p>'
      + '<button type="button" class="button secondary" data-update-site>Save site</button> '
      + '<button type="button" class="button secondary" data-set-site-agent>Set active agent</button>'
      + '</section>';
  }).join('');
}

export function renderDeviceSiteAssignmentState() {
  const target = byId('deviceSiteAssignmentState');
  if (!target) return;
  if (!state.selectedDevice) {
    target.textContent = 'Select a device in Operations before assigning it to a site.';
    return;
  }
  const readiness = readinessFor(state.selectedDevice.device_uid);
  const binding = readiness && readiness.active_binding ? ' Managing agent: ' + readiness.active_binding.agent_id + '.' : ' Managing agent binding not loaded.';
  target.textContent = deviceName(state.selectedDevice) + ' is assigned to '
    + (state.selectedDevice.site_name || 'no site') + '.' + binding;
}

function renderDeviceFormOptions() {
  const siteSelect = byId('deviceSiteInput');
  const agentSelect = byId('deviceAgentInput');
  if (siteSelect) siteSelect.innerHTML = siteOptions(state.sites[0] ? state.sites[0].site_id : '');
  if (agentSelect) agentSelect.innerHTML = agentOptions(state.agents[0] ? state.agents[0].id : '');
}

function renderDeviceSettingsList() {
  const target = byId('deviceSettingsList');
  if (!target) return;
  if (!state.devices.length) {
    target.textContent = 'No product-ready devices loaded.';
    return;
  }
  target.innerHTML = state.devices.map(device => {
    const c = connection(device);
    const readiness = readinessFor(device.device_uid);
    const agentId = activeBindingAgentId(device);
    const readinessLabel = readiness ? (readiness.readiness_label || readiness.readiness_status || '-') : 'readiness not loaded';
    return '<section class="settings-row" data-device-uid="' + esc(device.device_uid) + '">'
      + '<h4>' + esc(deviceName(device)) + '</h4>'
      + '<p class="muted-line">' + esc(provider(device) || '-') + ' · ' + esc(model(device) || '-') + ' · ' + esc(c.host) + ':' + esc(c.port) + ' · ' + esc(device.managed_status || '-') + '</p>'
      + '<label>Site <select data-device-site>' + siteOptions(deviceSiteId(device)) + '</select></label>'
      + '<label>Managing agent <select data-device-agent>' + agentOptions(agentId) + '</select></label>'
      + '<p class="muted-line">Readiness: ' + esc(readinessLabel) + '. ' + esc(capabilitySummary(readiness)) + '</p>'
      + '<p class="muted-line">Credentials are stored as write-only operational secrets; existing values are not shown.</p>'
      + '<button type="button" class="button secondary" data-assign-device-site>Assign site</button> '
      + '<button type="button" class="button secondary" data-bind-device-agent>Bind agent</button>'
      + '</section>';
  }).join('');
}

function renderPolicyCapabilityState() {
  const target = byId('policyCapabilityState');
  if (!target) return;
  const agent = state.agents.find(row => row.id === activeBindingAgentId(state.selectedDevice || {}) || row.id === (state.selectedDevice && state.selectedDevice.discovered_by_agent_id));
  const readiness = state.selectedDevice ? readinessFor(state.selectedDevice.device_uid) : null;
  target.innerHTML = '<dl>'
    + '<dt>K80 runtime policy</dt><dd>Requires known-good K80 runtime flags. Settings v1 is read-only for policy flags.</dd>'
    + '<dt>Runtime version</dt><dd>' + esc(agent ? ((agent.agent_reported_version || agent.agent_version || '-') + ' · ' + (agent.version_support_status || '-')) : 'No selected-device agent loaded') + '</dd>'
    + '<dt>Runtime command capability</dt><dd>' + esc(agent ? 'See agent heartbeat/capability governance; Settings v1 does not edit runtime capabilities.' : 'No agent loaded') + '</dd>'
    + '<dt>Device path capability</dt><dd>' + esc(capabilitySummary(readiness)) + '</dd>'
    + '</dl>';
}

export function renderSettingsPanels() {
  renderCompanyList();
  renderSites();
  renderDeviceSettingsList();
  renderPolicyCapabilityState();
}

export async function loadCompanies() {
  const data = await request('GET', '/api/companies', undefined, { include_inactive: 'true', limit: 200 });
  state.companies = rows(data);
  renderCompanies();
}

export async function loadSettingsEvidence() {
  await Promise.all([loadAgents(), loadSiteActiveAgents(), loadDeviceReadiness()]);
  renderSettingsPanels();
}

async function loadAgents() {
  try {
    state.settingsErrors.agents = '';
    const data = await request('GET', '/api/agent-admin/agents', undefined, { company_id: activeCompanyId(), limit: 100 });
    state.agents = rows(data).filter(isProductAgent);
  } catch (err) {
    state.agents = [];
    state.settingsErrors.agents = err && err.message ? err.message : 'agents unavailable';
  }
}

async function loadSiteActiveAgents() {
  state.siteActiveAgents = {};
  state.settingsErrors.siteAgents = '';
  const failures = [];
  await Promise.all(state.sites.map(async site => {
    try {
      state.siteActiveAgents[site.site_id] = await request('GET', '/api/agent-admin/sites/' + encodeURIComponent(site.site_id) + '/active-agent', undefined, { company_id: activeCompanyId() });
    } catch (err) {
      failures.push(siteDisplayName(site));
    }
  }));
  state.settingsErrors.siteAgents = failures.length ? 'active agent unavailable for ' + failures.join(', ') : '';
}

async function loadDeviceReadiness() {
  state.deviceReadiness = {};
  state.settingsErrors.deviceReadiness = '';
  const failures = [];
  await Promise.all(state.devices.map(async device => {
    try {
      const data = await request('GET', '/api/agent-admin/devices/' + encodeURIComponent(device.device_uid) + '/onboarding-readiness', undefined, { company_id: activeCompanyId(), online_window_minutes: 10 });
      state.deviceReadiness[device.device_uid] = data && data.value ? data.value : data;
    } catch (err) {
      failures.push(deviceName(device));
    }
  }));
  state.settingsErrors.deviceReadiness = failures.length ? 'readiness unavailable for ' + failures.join(', ') : '';
}

export async function addCompany(event) {
  event.preventDefault();
  if (!hasRole('admin')) throw new Error('insufficient_role');
  const body = {
    company_id: text(byId('companyIdInput').value).trim(),
    display_name: text(byId('companyNameInput').value).trim(),
    timezone: text(byId('companyTimezoneInput').value).trim() || 'Africa/Tunis'
  };
  if (!body.company_id || !body.display_name) throw new Error('Company ID and display name are required');
  await request('POST', '/api/companies', body);
  localStorage.setItem(storage.companyId, body.company_id);
  await loadCompanies();
  await loadDevices();
  await loadSettingsEvidence();
  setStatus('Employer saved.');
}

export async function addSite(event) {
  event.preventDefault();
  if (!hasRole('admin')) throw new Error('insufficient_role');
  const siteKey = text(byId('siteKeyInput').value).trim() || 'default-site';
  const existing = state.sites.find(site => text(site.site_key).trim() === siteKey);
  if (existing) {
    setStatus('Site already exists: ' + siteDisplayName(existing) + '.');
    renderSites();
    return;
  }
  const body = {
    company_id: activeCompanyId(),
    site_key: siteKey,
    site_name: text(byId('siteNameInput').value).trim() || 'Default Site',
    status: 'active',
    metadata: {
      timezone: text(byId('siteTimezoneInput').value).trim() || 'Africa/Tunis',
      created_from: 'product_app_settings'
    }
  };
  await request('POST', '/api/agent-admin/sites', body);
  await loadDevices();
  await loadSettingsEvidence();
  renderSites();
  setStatus('Site saved.');
}

async function updateSite(row) {
  if (!hasRole('admin')) throw new Error('insufficient_role');
  const siteId = row.getAttribute('data-site-id');
  const site = state.sites.find(item => item.site_id === siteId);
  if (!site) throw new Error('Site not found');
  const metadata = site.metadata && typeof site.metadata === 'object' ? { ...site.metadata } : {};
  metadata.timezone = text(row.querySelector('[data-site-timezone]').value).trim() || 'Africa/Tunis';
  await request('PATCH', '/api/agent-admin/sites/' + encodeURIComponent(siteId), {
    company_id: activeCompanyId(),
    site_name: text(row.querySelector('[data-site-name]').value).trim() || siteDisplayName(site),
    status: text(row.querySelector('[data-site-status]').value).trim() || 'active',
    metadata
  });
  await loadDevices();
  await loadSettingsEvidence();
  setStatus('Site updated.');
}

async function setSiteAgent(row) {
  if (!hasRole('admin')) throw new Error('insufficient_role');
  const siteId = row.getAttribute('data-site-id');
  const agentId = text(row.querySelector('[data-site-agent]').value).trim() || null;
  await request('PUT', '/api/agent-admin/sites/' + encodeURIComponent(siteId) + '/active-agent', {
    company_id: activeCompanyId(),
    agent_id: agentId,
    metadata: { source: 'product_app_settings' }
  });
  await loadDevices();
  await loadSettingsEvidence();
  setStatus('Site active agent updated.');
}

function generatedDeviceUid(vendor, host) {
  return (vendor || 'device') + ':manual:' + text(host).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

export async function addDevice(event) {
  event.preventDefault();
  if (!hasRole('admin')) throw new Error('insufficient_role');
  const vendor = text(byId('deviceVendorInput').value).trim() || 'zkteco';
  const host = text(byId('deviceHostInput').value).trim();
  const port = Number(byId('devicePortInput').value || 4370);
  const transport = text(byId('deviceTransportInput').value).trim() || 'tcp';
  const uid = generatedDeviceUid(vendor, host);
  const auth = text(byId('deviceAuthInput').value).trim();
  const siteId = text(byId('deviceSiteInput').value).trim();
  const agentId = text(byId('deviceAgentInput').value).trim();
  const deviceNameValue = text(byId('deviceNameInput').value).trim();
  const modelValue = text(byId('deviceModelInput').value).trim();
  if (!host) throw new Error('Device host is required');
  const connectionPayload = {
    host,
    port,
    transport,
    device_number: 1,
    attlog_sequence: vendor === 'zkteco' ? 'zktime_k80' : 'off'
  };
  if (auth) {
    connectionPayload.auth_password = auth;
    connectionPayload.communication_key = auth;
  }
  const body = {
    company_id: activeCompanyId(),
    provider: vendor,
    device_uid: uid,
    device_name: deviceNameValue,
    connection: connectionPayload,
    device_profile: {
      model: modelValue
    },
    site_context: siteId ? { site_id: siteId } : {},
    operator_notes: { source: 'product_app_settings' }
  };
  const onboarded = await request('POST', '/api/agent-admin/devices/manual-onboarding', body);
  const candidate = onboarded && onboarded.value ? onboarded.value : onboarded;
  const candidateUid = candidate.device_uid || uid;
  const claimed = await request('POST', '/api/agent-admin/discovered-devices/' + encodeURIComponent(candidateUid) + '/claim', {
    company_id: activeCompanyId(),
    provider: vendor,
    device_name: deviceNameValue,
    metadata: {
      label: deviceNameValue,
      model: modelValue,
      connection: connectionPayload
    }
  });
  const managedUid = (claimed && (claimed.device_uid || (claimed.value && claimed.value.device_uid))) || candidateUid;
  if (siteId) await assignDeviceToSite(managedUid, siteId);
  if (agentId) await bindDeviceToAgent(managedUid, agentId);
  byId('deviceAuthInput').value = '';
  await loadDevices();
  await loadSettingsEvidence();
  setStatus('Pointeuse saved and managed.');
}

async function assignDeviceToSite(deviceUid, siteId) {
  if (!hasRole('admin')) throw new Error('insufficient_role');
  await request(
    'PUT',
    '/api/agent-admin/devices/' + encodeURIComponent(deviceUid) + '/site',
    { company_id: activeCompanyId(), site_id: siteId || null }
  );
}

async function bindDeviceToAgent(deviceUid, agentId) {
  if (!hasRole('admin')) throw new Error('insufficient_role');
  await request(
    'PUT',
    '/api/agent-admin/devices/' + encodeURIComponent(deviceUid) + '/managing-agent-binding',
    {
      company_id: activeCompanyId(),
      agent_id: agentId,
      reason: 'product_app_settings',
      metadata: { source: 'product_app_settings' }
    }
  );
}

async function assignDeviceFromRow(row) {
  const deviceUid = row.getAttribute('data-device-uid');
  const siteId = text(row.querySelector('[data-device-site]').value).trim();
  await assignDeviceToSite(deviceUid, siteId || null);
  await loadDevices();
  await loadSettingsEvidence();
  setStatus('Device site assignment updated.');
}

async function bindDeviceFromRow(row) {
  const deviceUid = row.getAttribute('data-device-uid');
  const agentId = text(row.querySelector('[data-device-agent]').value).trim();
  if (!agentId) throw new Error('Choose an active agent first');
  await bindDeviceToAgent(deviceUid, agentId);
  await loadDevices();
  await loadSettingsEvidence();
  setStatus('Device managing agent updated.');
}

export async function assignSelectedDeviceToDefaultSite() {
  if (!hasRole('admin')) throw new Error('insufficient_role');
  if (!state.selectedDevice) throw new Error('Select a product-ready device first');
  const site = state.sites.find(row => row.site_key === 'default-site') || state.sites[0];
  if (!site || !site.site_id) throw new Error('Create or load a site first');
  await assignDeviceToSite(state.selectedDevice.device_uid, site.site_id);
  await loadDevices();
  await loadSettingsEvidence();
  renderSites();
  setStatus('Selected device assigned to ' + siteDisplayName(site) + '.');
}

export function bindSettings() {
  document.querySelectorAll('[data-toggle-details]').forEach(button => {
    button.addEventListener('click', () => {
      const details = byId(button.getAttribute('data-toggle-details'));
      if (details) details.open = !details.open;
    });
  });
  byId('companyForm').addEventListener('submit', event => addCompany(event).catch(err => setStatus('Company save failed: ' + err.message)));
  byId('siteForm').addEventListener('submit', event => addSite(event).catch(err => setStatus('Site save failed: ' + err.message)));
  byId('siteList').addEventListener('click', event => {
    const row = event.target.closest('[data-site-id]');
    if (!row) return;
    if (event.target.matches('[data-update-site]')) updateSite(row).catch(err => setStatus('Site update failed: ' + err.message));
    if (event.target.matches('[data-set-site-agent]')) setSiteAgent(row).catch(err => setStatus('Site agent update failed: ' + err.message));
  });
  byId('assignSelectedDeviceSite').addEventListener('click', () => assignSelectedDeviceToDefaultSite().catch(err => setStatus('Site assignment failed: ' + err.message)));
  byId('deviceSettingsList').addEventListener('click', event => {
    const row = event.target.closest('[data-device-uid]');
    if (!row) return;
    if (event.target.matches('[data-assign-device-site]')) assignDeviceFromRow(row).catch(err => setStatus('Device site assignment failed: ' + err.message));
    if (event.target.matches('[data-bind-device-agent]')) bindDeviceFromRow(row).catch(err => setStatus('Device agent binding failed: ' + err.message));
  });
  byId('companySelect').addEventListener('change', async () => {
    localStorage.setItem(storage.companyId, activeCompanyId());
    state.selectedDeviceUid = '';
    state.selectedDeviceRtRows = [];
    state.selectedDeviceMonitoringSession = null;
    state.selectedDeviceSyncState = null;
    state.selectedDeviceTechnicalDetails = { evidence: '', monitoring: '', sync: '' };
    state.selectedDeviceLiveProof = false;
    closeSse('Live connection stopped.');
    await loadDevices();
    await loadSettingsEvidence();
    renderSites();
    await refreshRtRows();
    openSse();
  });
  byId('deviceForm').addEventListener('submit', event => addDevice(event).catch(err => setStatus('Device save failed: ' + err.message)));
}
