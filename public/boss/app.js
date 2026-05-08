(function () {
  const STORAGE = {
    baseUrl: 'boss.baseUrl',
    companyId: 'boss.companyId',
    environment: 'boss.environment',
    apiKey: 'boss.apiKey'
  };

  const state = {
    activeTab: 'overview',
    onlineWindowMinutes: 10,
    progressContext: null,
    queuePullInFlight: false,
    selectedDeviceUid: '',
    opsSelectedDeviceUid: '',
    opsDevices: [],
    opsReadinessByDeviceUid: {},
    opsActivityByDeviceUid: {},
    opsMonitoringSession: null,
    opsRealtimeRows: [],
    opsRealtimeSource: null,
    opsRealtimeProofReceived: false
  };
  const PULL_IN_PROGRESS_STALE_MINUTES = 30;

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeBaseUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) {
      return window.location.origin;
    }
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value.replace(/\/+$/, '');
    }
    return ('http://' + value).replace(/\/+$/, '');
  }

  function getConfig() {
    return {
      baseUrl: normalizeBaseUrl(byId('baseUrl').value),
      companyId: String(byId('companyId').value || '').trim() || 'DEFAULT',
      environment: String(byId('environment').value || '').trim() || 'Local',
      apiKey: String(byId('apiKey').value || '').trim()
    };
  }

  function persistConfig() {
    const cfg = getConfig();
    localStorage.setItem(STORAGE.baseUrl, cfg.baseUrl);
    localStorage.setItem(STORAGE.companyId, cfg.companyId);
    localStorage.setItem(STORAGE.environment, cfg.environment);
    localStorage.setItem(STORAGE.apiKey, cfg.apiKey);
  }

  function restoreConfig() {
    byId('baseUrl').value = localStorage.getItem(STORAGE.baseUrl) || window.location.origin;
    byId('companyId').value = localStorage.getItem(STORAGE.companyId) || 'DEFAULT';
    byId('environment').value = localStorage.getItem(STORAGE.environment) || 'Local';
    byId('apiKey').value = localStorage.getItem(STORAGE.apiKey) || '';
  }

  function buildUrl(path, query) {
    const cfg = getConfig();
    const url = new URL(path, cfg.baseUrl + '/');
    Object.keys(query || {}).forEach(key => {
      const raw = query[key];
      if (raw === undefined || raw === null) {
        return;
      }
      const text = String(raw).trim();
      if (!text) {
        return;
      }
      url.searchParams.set(key, text);
    });
    return url.toString();
  }

  async function parseResponse(res) {
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (type.includes('application/json')) {
      return res.json();
    }
    return res.text();
  }

  async function apiGet(path, query) {
    const cfg = getConfig();
    const headers = {};
    if (cfg.apiKey) {
      headers['x-api-key'] = cfg.apiKey;
    }
    const response = await fetch(buildUrl(path, query), {
      method: 'GET',
      headers
    });
    const data = await parseResponse(response);
    if (!response.ok) {
      const message = data && data.message ? data.message : ('HTTP ' + response.status);
      const detail = data && data.details && data.details.error ? data.details.error : '';
      const err = new Error(detail ? (message + ' (' + detail + ')') : message);
      err.status = response.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async function apiPost(path, body) {
    const cfg = getConfig();
    const headers = {
      'content-type': 'application/json'
    };
    if (cfg.apiKey) {
      headers['x-api-key'] = cfg.apiKey;
    }
    const response = await fetch(buildUrl(path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {})
    });
    const data = await parseResponse(response);
    if (!response.ok) {
      const message = data && data.message ? data.message : ('HTTP ' + response.status);
      const detail = data && data.details && data.details.error ? data.details.error : '';
      const err = new Error(detail ? (message + ' (' + detail + ')') : message);
      err.status = response.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async function apiPut(path, body) {
    const cfg = getConfig();
    const headers = {
      'content-type': 'application/json'
    };
    if (cfg.apiKey) {
      headers['x-api-key'] = cfg.apiKey;
    }
    const response = await fetch(buildUrl(path), {
      method: 'PUT',
      headers,
      body: JSON.stringify(body || {})
    });
    const data = await parseResponse(response);
    if (!response.ok) {
      const message = data && data.message ? data.message : ('HTTP ' + response.status);
      const detail = data && data.details && data.details.error ? data.details.error : '';
      const err = new Error(detail ? (message + ' (' + detail + ')') : message);
      err.status = response.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async function apiDelete(path, body) {
    const cfg = getConfig();
    const headers = {
      'content-type': 'application/json'
    };
    if (cfg.apiKey) {
      headers['x-api-key'] = cfg.apiKey;
    }
    const response = await fetch(buildUrl(path), {
      method: 'DELETE',
      headers,
      body: JSON.stringify(body || {})
    });
    const data = await parseResponse(response);
    if (!response.ok) {
      const message = data && data.message ? data.message : ('HTTP ' + response.status);
      const detail = data && data.details && data.details.error ? data.details.error : '';
      const err = new Error(detail ? (message + ' (' + detail + ')') : message);
      err.status = response.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  function extractRows(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload && Array.isArray(payload.value)) {
      return payload.value;
    }
    return [];
  }

  function parseObject(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch (err) {
        // best-effort only
      }
    }
    return {};
  }

  function firstNonEmpty(values) {
    for (let i = 0; i < values.length; i += 1) {
      const raw = values[i];
      if (raw === undefined || raw === null) {
        continue;
      }
      const text = String(raw).trim();
      if (text) {
        return text;
      }
    }
    return '';
  }

  function toCount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  function kv(label, value) {
    return (
      '<div class="kv">' +
        '<div class="kv-label">' + escapeHtml(label) + '</div>' +
        '<div class="kv-value">' + escapeHtml(value || '-') + '</div>' +
      '</div>'
    );
  }

  function renderValidatedProgressEmpty(message) {
    const el = byId('validatedProgressBody');
    if (!el) {
      return;
    }
    el.innerHTML = '<p class="empty">' + escapeHtml(message) + '</p>';
  }

  function setQueuePullFeedback(kind, text) {
    const el = byId('queuePullFeedback');
    if (!el) {
      return;
    }
    el.className = 'validated-feedback';
    if (kind === 'ok' || kind === 'warn' || kind === 'err') {
      el.classList.add(kind);
    }
    el.textContent = text;
  }

  function setQueuePullButtonState(context) {
    const button = byId('btnQueuePullNow');
    if (!button) {
      return;
    }
    const label = context && context.actionLabel
      ? context.actionLabel
      : 'Queue Pull Now';
    const busyLabel = context && context.busyLabel
      ? context.busyLabel
      : 'Working...';
    button.disabled = state.queuePullInFlight || !(context && context.actionEligible);
    button.textContent = state.queuePullInFlight ? busyLabel : label;
  }

  function clearProgressContext(message) {
    state.progressContext = null;
    setQueuePullButtonState(null);
    if (message) {
      setQueuePullFeedback('warn', message);
    }
  }

  function pickProgressDevice(rows, preferredDeviceUid) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }
    const preferred = String(preferredDeviceUid || '').trim().toLowerCase();
    if (preferred) {
      const direct = rows.find(row => String(row && row.device_uid || '').toLowerCase() === preferred);
      if (direct) {
        return direct;
      }
    }

    const validated = rows.find(row => {
      const manageability = String(row && row.manageability_status || '').toLowerCase();
      return manageability === 'ingesting' || manageability === 'manageable';
    });
    if (validated) {
      return validated;
    }
    return rows[0];
  }

  function extractDeviceFacts(row) {
    const metadata = parseObject(row && row.metadata);
    const discovery = parseObject(row && row.discovery_metadata);
    return {
      deviceUid: firstNonEmpty([row && row.device_uid]),
      label: firstNonEmpty([metadata.label, metadata.device_label, discovery.label, discovery.device_label]),
      identifier: firstNonEmpty([
        metadata.serial,
        metadata.serial_number,
        discovery.serial,
        discovery.serial_number,
        metadata.device_id,
        discovery.device_id
      ]),
      host: firstNonEmpty([
        discovery.ip,
        metadata.ip,
        discovery.host,
        metadata.host,
        metadata.connection_host
      ]),
      vendor: firstNonEmpty([row && row.provider, metadata.vendor, discovery.vendor]),
      model: firstNonEmpty([
        metadata.model,
        discovery.model,
        metadata.device_model,
        discovery.device_model,
        metadata.platform,
        discovery.platform
      ]),
      firmware: firstNonEmpty([
        metadata.firmware,
        discovery.firmware,
        metadata.firmware_version,
        discovery.firmware_version
      ]),
      managedStatus: firstNonEmpty([row && row.managed_status]),
      manageabilityStatus: firstNonEmpty([row && row.manageability_status])
    };
  }

  function selectLatestSuccessfulBatch(rows) {
    if (!Array.isArray(rows)) {
      return null;
    }
    return rows.find(row => {
      const status = String(row && row.status || '').toLowerCase();
      return status === 'accepted' || status === 'partial';
    }) || null;
  }

  function selectLatestRelevantCommand(rows) {
    if (!Array.isArray(rows)) {
      return null;
    }
    return rows.find(row => String(row && row.command_type || '').toUpperCase() === 'PULL_DEVICE_EVENTS') || rows[0] || null;
  }

  function resolveProgressAgentId(deviceRow, evidence) {
    return firstNonEmpty([
      evidence && evidence.readiness && evidence.readiness.active_binding && evidence.readiness.active_binding.agent_id,
      evidence && evidence.readiness && evidence.readiness.managing_agent && evidence.readiness.managing_agent.id,
      evidence && evidence.syncRow && evidence.syncRow.agent_id,
      evidence && evidence.latestCommand && evidence.latestCommand.agent_id,
      deviceRow && deviceRow.last_agent_id,
      deviceRow && deviceRow.discovered_by_agent_id,
      deviceRow && deviceRow.agent_id
    ]);
  }

  function normalizeLifecycleScope(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'bridge_ops' || normalized === 'ingest_only') {
      return normalized;
    }
    return '';
  }

  function lifecycleScopeLabel(value) {
    const scope = normalizeLifecycleScope(value);
    if (scope === 'bridge_ops') {
      return 'bridge_ops';
    }
    if (scope === 'ingest_only') {
      return 'ingest_only';
    }
    return value || '-';
  }

  function getDevicesLifecycleScopeFilterValue() {
    const input = byId('devicesLifecycleScope');
    if (!input) {
      return 'bridge_ops';
    }
    const value = String(input.value || '').trim().toLowerCase();
    if (value === 'all' || value === 'bridge_ops' || value === 'ingest_only') {
      return value;
    }
    return 'bridge_ops';
  }

  function normalizeOnboardingState(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (
      normalized === 'candidate_unconfigured'
      || normalized === 'candidate_configured'
      || normalized === 'validation_failed'
      || normalized === 'validation_succeeded'
      || normalized === 'managed_unbound'
      || normalized === 'managed_pull_ready'
    ) {
      return normalized;
    }
    return '';
  }

  function readinessStatusLabel(value) {
    const key = String(value || '').trim().toLowerCase();
    const labels = {
      candidate_incomplete_configuration: 'Candidate - incomplete configuration',
      candidate_ready_for_validation: 'Candidate - ready for validation',
      validation_failed: 'Validation failed',
      validation_succeeded: 'Validation succeeded',
      managed_unbound: 'Managed - unbound',
      managed_pull_ready: 'Managed - pull ready',
      managed_blocked_agent_offline: 'Managed - blocked (agent offline)'
    };
    return labels[key] || (value || '-');
  }

  function validationStatusLabel(value) {
    const key = String(value || '').trim().toLowerCase();
    const labels = {
      never_run: 'Not run',
      queued: 'Queued',
      in_progress: 'In progress',
      failed: 'Failed',
      succeeded: 'Succeeded'
    };
    return labels[key] || (value || '-');
  }

  function readinessStatusKind(value) {
    const key = String(value || '').trim().toLowerCase();
    if (
      key === 'candidate_ready_for_validation'
      || key === 'validation_succeeded'
      || key === 'managed_pull_ready'
    ) {
      return 'ok';
    }
    if (
      key === 'candidate_incomplete_configuration'
      || key === 'managed_unbound'
    ) {
      return 'warn';
    }
    if (
      key === 'validation_failed'
      || key === 'managed_blocked_agent_offline'
    ) {
      return 'danger';
    }
    return 'neutral';
  }

  function validationStatusKind(value) {
    const key = String(value || '').trim().toLowerCase();
    if (key === 'succeeded') {
      return 'ok';
    }
    if (key === 'failed') {
      return 'danger';
    }
    if (key === 'queued' || key === 'in_progress') {
      return 'warn';
    }
    return 'neutral';
  }

  function summarizeValidationEvidence(payload) {
    if (!payload || typeof payload !== 'object') {
      return '-';
    }
    if (payload.evidence && typeof payload.evidence === 'object') {
      const keys = Object.keys(payload.evidence).slice(0, 3);
      if (keys.length > 0) {
        return keys.map(key => key + '=' + String(payload.evidence[key])).join(', ');
      }
    }
    if (payload.reason_code) {
      return String(payload.reason_code);
    }
    return '-';
  }

  function getOnboardingAgentInputValue() {
    const input = byId('onboardingAgentId');
    return input ? String(input.value || '').trim() : '';
  }

  function setOnboardingAgentInputValue(value, options) {
    const input = byId('onboardingAgentId');
    if (!input) {
      return;
    }
    const safeValue = String(value || '').trim();
    const force = options && options.force === true;
    if (force || !String(input.value || '').trim()) {
      input.value = safeValue;
    }
  }

  function resolveQueueAgentContext(deviceRow, evidence) {
    const syncAgentId = firstNonEmpty([
      evidence && evidence.syncRow && evidence.syncRow.agent_id
    ]);
    if (syncAgentId) {
      return { agentId: syncAgentId, source: 'sync_state' };
    }
    const commandAgentId = firstNonEmpty([
      evidence && evidence.latestCommand && evidence.latestCommand.agent_id
    ]);
    if (commandAgentId) {
      return { agentId: commandAgentId, source: 'command_history' };
    }
    const discoveryAgentId = firstNonEmpty([
      deviceRow && deviceRow.discovered_by_agent_id,
      deviceRow && deviceRow.agent_id
    ]);
    if (discoveryAgentId) {
      return { agentId: discoveryAgentId, source: 'discovery_only' };
    }
    return { agentId: '', source: 'none' };
  }

  function deriveProgressActionContext(deviceRow, evidence, companyId) {
    const deviceUid = firstNonEmpty([deviceRow && deviceRow.device_uid]);
    const lifecycleScope = normalizeLifecycleScope(deviceRow && deviceRow.lifecycle_scope);
    const managedStatus = String(deviceRow && deviceRow.managed_status || '').toLowerCase();
    const queueAgent = resolveQueueAgentContext(deviceRow, evidence);
    const readiness = evidence && evidence.readiness ? evidence.readiness : null;
    const readinessStatus = String(readiness && readiness.readiness_status || '').toLowerCase();
    const onboardingState = normalizeOnboardingState(readiness && readiness.onboarding_state);
    const selectedAgentId = getOnboardingAgentInputValue();
    const suggestedAgentId = firstNonEmpty([
      selectedAgentId,
      readiness && readiness.suggested_agent_id,
      readiness && readiness.active_binding && readiness.active_binding.agent_id,
      queueAgent.agentId
    ]);
    const readinessReason = firstNonEmpty([
      readiness && readiness.readiness_reason
    ]);
    const managingAgentOnline = readiness
      && readiness.managing_agent
      && readiness.managing_agent.is_online_now === true;

    if (!deviceUid) {
      return {
        actionType: 'none',
        actionLabel: 'No Action',
        busyLabel: 'Working...',
        actionEligible: false,
        reason: 'This row is missing a device ID, so actions are unavailable.',
        feedbackKind: 'warn',
        companyId,
        deviceUid: '',
        agentId: '',
        agentEvidenceSource: queueAgent.source
      };
    }

    if (lifecycleScope && lifecycleScope !== 'bridge_ops') {
      return {
        actionType: 'none',
        actionLabel: 'Diagnostics Only',
        busyLabel: 'Working...',
        actionEligible: false,
        reason: 'This device is in diagnostic scope only, so pull actions are disabled.',
        feedbackKind: 'warn',
        companyId,
        deviceUid,
        agentId: '',
        agentEvidenceSource: queueAgent.source
      };
    }

    if (readinessStatus === 'candidate_incomplete_configuration' || onboardingState === 'candidate_unconfigured') {
      return {
        actionType: 'none',
        actionLabel: 'No Action',
        busyLabel: 'Working...',
        actionEligible: false,
        reason: readinessReason || 'Configuration is incomplete. Fill required fields before validation.',
        feedbackKind: 'warn',
        companyId,
        deviceUid,
        agentId: '',
        agentEvidenceSource: queueAgent.source
      };
    }

    const needsValidation = (
      readinessStatus === 'candidate_ready_for_validation'
      || readinessStatus === 'validation_failed'
      || onboardingState === 'candidate_configured'
      || onboardingState === 'validation_failed'
    );
    if (needsValidation) {
      if (!suggestedAgentId) {
        return {
          actionType: 'validate_candidate',
          actionLabel: 'Validate Device',
          busyLabel: 'Queueing validation...',
          actionEligible: false,
          reason: 'Select an active agent ID to run validation.',
          feedbackKind: 'warn',
          companyId,
          deviceUid,
          agentId: '',
          agentEvidenceSource: queueAgent.source
        };
      }
      return {
        actionType: 'validate_candidate',
        actionLabel: 'Validate Device',
        busyLabel: 'Queueing validation...',
        actionEligible: true,
        reason: readinessReason || 'Configuration is complete. Run validation from the selected agent.',
        feedbackKind: 'ok',
        companyId,
        deviceUid,
        agentId: suggestedAgentId,
        agentEvidenceSource: queueAgent.source
      };
    }

    if (readinessStatus === 'validation_succeeded' || onboardingState === 'validation_succeeded') {
      return {
        actionType: 'claim_candidate',
        actionLabel: 'Claim Device',
        busyLabel: 'Claiming...',
        actionEligible: true,
        reason: readinessReason || 'Validation succeeded. Claim this device to continue.',
        feedbackKind: 'ok',
        companyId,
        deviceUid,
        agentId: '',
        agentEvidenceSource: queueAgent.source
      };
    }

    if (readinessStatus === 'managed_unbound' || onboardingState === 'managed_unbound') {
      if (!suggestedAgentId) {
        return {
          actionType: 'bind_managing_agent',
          actionLabel: 'Bind Agent',
          busyLabel: 'Binding...',
          actionEligible: false,
          reason: readinessReason || 'Enter an active agent ID to bind this managed device.',
          feedbackKind: 'warn',
          companyId,
          deviceUid,
          agentId: '',
          agentEvidenceSource: queueAgent.source
        };
      }
      return {
        actionType: 'bind_managing_agent',
        actionLabel: 'Bind Agent',
        busyLabel: 'Binding...',
        actionEligible: true,
        reason: readinessReason || 'Bind this managed device to the selected agent.',
        feedbackKind: 'ok',
        companyId,
        deviceUid,
        agentId: suggestedAgentId,
        agentEvidenceSource: queueAgent.source
      };
    }

    if (readinessStatus === 'managed_blocked_agent_offline') {
      return {
        actionType: 'queue_pull',
        actionLabel: 'Queue Pull Now',
        busyLabel: 'Queueing...',
        actionEligible: false,
        reason: readinessReason || 'Managing agent is offline; pull is not actionable right now.',
        feedbackKind: 'warn',
        companyId,
        deviceUid,
        agentId: suggestedAgentId || '',
        agentEvidenceSource: queueAgent.source
      };
    }

    if (readinessStatus === 'managed_pull_ready' || onboardingState === 'managed_pull_ready') {
      const bindingAgentId = firstNonEmpty([
        readiness && readiness.active_binding && readiness.active_binding.agent_id,
        suggestedAgentId
      ]);
      if (!bindingAgentId) {
        return {
          actionType: 'queue_pull',
          actionLabel: 'Queue Pull Now',
          busyLabel: 'Queueing...',
          actionEligible: false,
          reason: 'Managed device is missing a binding agent ID.',
          feedbackKind: 'warn',
          companyId,
          deviceUid,
          agentId: '',
          agentEvidenceSource: queueAgent.source
        };
      }
      if (readiness && readiness.managing_agent && !managingAgentOnline) {
        return {
          actionType: 'queue_pull',
          actionLabel: 'Queue Pull Now',
          busyLabel: 'Queueing...',
          actionEligible: false,
          reason: 'Managing agent is offline; pull is currently blocked.',
          feedbackKind: 'warn',
          companyId,
          deviceUid,
          agentId: bindingAgentId,
          agentEvidenceSource: queueAgent.source
        };
      }
      return {
        actionType: 'queue_pull',
        actionLabel: 'Queue Pull Now',
        busyLabel: 'Queueing...',
        actionEligible: true,
        reason: readinessReason || 'Managed device is pull-ready.',
        feedbackKind: 'ok',
        companyId,
        deviceUid,
        agentId: bindingAgentId,
        agentEvidenceSource: queueAgent.source
      };
    }

    if (managedStatus !== 'managed') {
      return {
        actionType: 'none',
        actionLabel: 'No Action',
        busyLabel: 'Working...',
        actionEligible: false,
        reason: 'This device state is not actionable in bridge operations.',
        feedbackKind: 'warn',
        companyId,
        deviceUid,
        agentId: '',
        agentEvidenceSource: queueAgent.source
      };
    }

    if (!suggestedAgentId) {
      return {
        actionType: 'queue_pull',
        actionLabel: 'Queue Pull Now',
        busyLabel: 'Queueing...',
        actionEligible: false,
        reason: 'This device is managed, but no managing agent is resolved yet.',
        feedbackKind: 'warn',
        companyId,
        deviceUid,
        agentId: '',
        agentEvidenceSource: queueAgent.source
      };
    }

    if (queueAgent.source === 'discovery_only') {
      return {
        actionType: 'queue_pull',
        actionLabel: 'Queue Pull Now',
        busyLabel: 'Queueing...',
        actionEligible: false,
        reason: 'This device is known, but its active managing agent is not confirmed yet.',
        feedbackKind: 'warn',
        companyId,
        deviceUid,
        agentId: suggestedAgentId,
        agentEvidenceSource: queueAgent.source
      };
    }

    return {
      actionType: 'queue_pull',
      actionLabel: 'Queue Pull Now',
      busyLabel: 'Queueing...',
      actionEligible: true,
      reason: 'This device is ready for pull. You can queue a pull now.',
      feedbackKind: 'ok',
      companyId,
      deviceUid,
      agentId: suggestedAgentId,
      agentEvidenceSource: queueAgent.source
    };
  }

  function timestampMs(value) {
    if (!value) {
      return null;
    }
    const ms = new Date(value).getTime();
    if (Number.isNaN(ms)) {
      return null;
    }
    return ms;
  }

  function maxTimestampMs(values) {
    const source = Array.isArray(values) ? values : [];
    const valid = source
      .map(value => timestampMs(value))
      .filter(ms => ms !== null);
    if (valid.length === 0) {
      return null;
    }
    return Math.max.apply(null, valid);
  }

  function evaluatePullCommandProgress(latestCommand, timingEvidence) {
    const commandStatus = String(latestCommand && latestCommand.status || '').toLowerCase();
    const queuedOrSent = commandStatus === 'queued' || commandStatus === 'sent';
    if (!queuedOrSent) {
      return {
        isInProgress: false,
        stale: false,
        completionAfterCommand: false
      };
    }

    const commandStartedAt = firstNonEmpty([
      latestCommand && latestCommand.sent_at,
      latestCommand && latestCommand.created_at
    ]);
    const commandStartedAtMs = timestampMs(commandStartedAt);
    const completionMs = maxTimestampMs([
      timingEvidence && timingEvidence.lastSuccessfulPullAt,
      timingEvidence && timingEvidence.latestBatchPullCompletedAt,
      timingEvidence && timingEvidence.lastSyncCompletedAt
    ]);
    const completionAfterCommand = commandStartedAtMs !== null
      && completionMs !== null
      && completionMs >= commandStartedAtMs;
    const expiresAtMs = timestampMs(latestCommand && latestCommand.expires_at);
    const expired = expiresAtMs !== null && expiresAtMs <= Date.now();
    const staleByAge = (() => {
      const ageMinutes = minutesSince(commandStartedAt);
      return ageMinutes !== null && ageMinutes > PULL_IN_PROGRESS_STALE_MINUTES;
    })();
    const stale = !completionAfterCommand && (expired || staleByAge);

    return {
      isInProgress: !completionAfterCommand && !stale,
      stale,
      completionAfterCommand
    };
  }

  function summarizeLiveViewStatus(row, facts, actionContext, latestCommand, dataReceived, timingEvidence, readiness) {
    const lifecycleScope = normalizeLifecycleScope(row && row.lifecycle_scope);
    const managedStatus = String(row && row.managed_status || '').toLowerCase();
    const commandProgress = evaluatePullCommandProgress(latestCommand, timingEvidence);
    const deviceInBridgeFlow = Boolean(facts && facts.deviceUid) && lifecycleScope === 'bridge_ops';
    const pullReady = Boolean(actionContext && actionContext.actionType === 'queue_pull' && actionContext.actionEligible);
    const hasData = Boolean(dataReceived);
    const readinessStatus = String(readiness && readiness.readiness_status || '').toLowerCase();
    const readinessReason = firstNonEmpty([readiness && readiness.readiness_reason]);
    const readinessLabel = readinessStatusLabel(readinessStatus);

    if (!(facts && facts.deviceUid)) {
      return {
        deviceInBridgeFlow,
        pullReady,
        hasData,
        stateLabel: 'Not detected',
        stateKind: 'warn',
        reason: 'No device row is available in the current filter.'
      };
    }

    if (lifecycleScope && lifecycleScope !== 'bridge_ops') {
      return {
        deviceInBridgeFlow,
        pullReady,
        hasData,
        stateLabel: 'Diagnostic only',
        stateKind: 'warn',
        reason: 'This row is outside bridge operations, so queue actions are disabled.'
      };
    }

    if (readinessStatus === 'candidate_incomplete_configuration') {
      return {
        deviceInBridgeFlow,
        pullReady,
        hasData,
        stateLabel: readinessLabel,
        stateKind: 'warn',
        reason: readinessReason || 'Add required configuration fields before validation.'
      };
    }

    if (readinessStatus === 'candidate_ready_for_validation') {
      return {
        deviceInBridgeFlow,
        pullReady,
        hasData,
        stateLabel: readinessLabel,
        stateKind: 'ok',
        reason: readinessReason || 'Run validation from a selected site agent.'
      };
    }

    if (readinessStatus === 'validation_failed') {
      return {
        deviceInBridgeFlow,
        pullReady,
        hasData,
        stateLabel: readinessLabel,
        stateKind: 'danger',
        reason: readinessReason || 'Validation failed. Review reason and retry.'
      };
    }

    if (readinessStatus === 'validation_succeeded') {
      return {
        deviceInBridgeFlow,
        pullReady,
        hasData,
        stateLabel: readinessLabel,
        stateKind: 'ok',
        reason: readinessReason || 'Validation passed. Claim to continue lifecycle.'
      };
    }

    if (readinessStatus === 'managed_unbound') {
      return {
        deviceInBridgeFlow,
        pullReady,
        hasData,
        stateLabel: readinessLabel,
        stateKind: 'warn',
        reason: readinessReason || 'Managed device needs an active managing-agent binding.'
      };
    }

    if (readinessStatus === 'managed_blocked_agent_offline') {
      return {
        deviceInBridgeFlow,
        pullReady,
        hasData,
        stateLabel: readinessLabel,
        stateKind: 'danger',
        reason: readinessReason || 'Managing agent is offline.'
      };
    }

    if (managedStatus !== 'managed' && !readinessStatus) {
      return {
        deviceInBridgeFlow,
        pullReady,
        hasData,
        stateLabel: 'Not actionable',
        stateKind: 'warn',
        reason: 'The current managed state does not allow pull actions here.'
      };
    }

    if (commandProgress.isInProgress) {
      return {
        deviceInBridgeFlow,
        pullReady,
        hasData,
        stateLabel: 'Pull in progress',
        stateKind: 'warn',
        reason: 'A pull command is in progress and awaiting completion.'
      };
    }

    if (hasData) {
      let reason = 'Recent pulled data is available below.';
      if (commandProgress.completionAfterCommand) {
        reason = 'Recent pulled data arrived after the latest pull request.';
      } else if (commandProgress.stale) {
        reason = 'Recent pulled data is available; a stale queued command no longer blocks readiness.';
      }
      return {
        deviceInBridgeFlow,
        pullReady,
        hasData,
        stateLabel: 'Data received',
        stateKind: 'ok',
        reason
      };
    }

    if (pullReady || readinessStatus === 'managed_pull_ready') {
      const reason = commandProgress.stale
        ? 'The latest queued pull command appears stale. You can queue a fresh pull now.'
        : (readinessReason || 'The device is ready. Use Queue Pull Now to fetch data.');
      return {
        deviceInBridgeFlow,
        pullReady,
        hasData,
        stateLabel: readinessStatus === 'managed_pull_ready' ? readinessLabel : 'Ready for first pull',
        stateKind: 'ok',
        reason
      };
    }

    return {
      deviceInBridgeFlow,
      pullReady,
      hasData,
      stateLabel: 'Blocked',
      stateKind: 'danger',
      reason: actionContext && actionContext.reason
        ? actionContext.reason
        : 'This device is known, but it is not ready for pull yet.'
    };
  }

  function yesNoLabel(value) {
    return value ? 'Yes' : 'No';
  }

  function isRecentIso(value, minutesThreshold) {
    const minutes = minutesSince(value);
    return minutes !== null && minutes <= minutesThreshold;
  }

  async function loadValidatedProgressEvidence(companyId, deviceUid) {
    const [syncPayload, batchPayload, commandPayload, recentEventsPayload, readinessPayload] = await Promise.all([
      apiGet('/api/agent-admin/device-sync-states', {
        company_id: companyId,
        device_uid: deviceUid,
        limit: 10
      }),
      apiGet('/api/agent-admin/device-event-batches', {
        company_id: companyId,
        device_uid: deviceUid,
        limit: 20
      }),
      apiGet('/api/agent-admin/commands', {
        company_id: companyId,
        device_uid: deviceUid,
        limit: 20
      }),
      apiGet('/api/agent-admin/device-events/recent', {
        company_id: companyId,
        device_uid: deviceUid,
        limit: 20
      }),
      apiGet('/api/agent-admin/devices/' + encodeURIComponent(deviceUid) + '/onboarding-readiness', {
        company_id: companyId,
        online_window_minutes: state.onlineWindowMinutes
      })
    ]);
    const syncRows = extractRows(syncPayload);
    const batchRows = extractRows(batchPayload);
    const commandRows = extractRows(commandPayload);
    const recentEvents = extractRows(recentEventsPayload);
    const readiness = readinessPayload && typeof readinessPayload === 'object' ? readinessPayload : null;
    const syncRow = syncRows[0] || null;
    const latestCommand = selectLatestRelevantCommand(commandRows);
    const impliedAgentId = firstNonEmpty([
      readiness && readiness.managing_agent && readiness.managing_agent.id,
      readiness && readiness.active_binding && readiness.active_binding.agent_id,
      syncRow && syncRow.agent_id,
      latestCommand && latestCommand.agent_id
    ]);
    let agentRow = null;
    if (readiness && readiness.managing_agent) {
      agentRow = readiness.managing_agent;
    } else if (impliedAgentId) {
      try {
        const agentsPayload = await apiGet('/api/agent-admin/agents', {
          company_id: companyId,
          limit: 200
        });
        const agentRows = extractRows(agentsPayload);
        agentRow = agentRows.find(row => String(row && row.id || '') === impliedAgentId) || null;
      } catch (err) {
        agentRow = null;
      }
    }
    return {
      syncRow,
      latestBatch: batchRows[0] || null,
      successfulBatch: selectLatestSuccessfulBatch(batchRows),
      latestCommand,
      readiness,
      agentRow,
      recentEvents
    };
  }

  function renderValidatedProgress(row, evidence, actionContext, note) {
    const el = byId('validatedProgressBody');
    if (!el) {
      return;
    }
    if (!row) {
      renderValidatedProgressEmpty('No device rows loaded.');
      return;
    }

    const facts = extractDeviceFacts(row);
    const syncRow = evidence && evidence.syncRow ? evidence.syncRow : null;
    const successfulBatch = evidence && evidence.successfulBatch ? evidence.successfulBatch : null;
    const latestBatch = evidence && evidence.latestBatch ? evidence.latestBatch : null;
    const latestCommand = evidence && evidence.latestCommand ? evidence.latestCommand : null;
    const readiness = evidence && evidence.readiness ? evidence.readiness : null;
    const agentRow = evidence && evidence.agentRow ? evidence.agentRow : null;
    const recentEvents = evidence && Array.isArray(evidence.recentEvents) ? evidence.recentEvents : [];
    const batchForCounts = successfulBatch || latestBatch;
    const batchTotalCount = batchForCounts
      ? toCount(batchForCounts.inserted_count) + toCount(batchForCounts.deduped_count) + toCount(batchForCounts.rejected_count)
      : 0;
    const recentOperationalEvidence = (
      isRecentIso(syncRow && syncRow.last_sync_completed_at, 1440) ||
      isRecentIso(batchForCounts && batchForCounts.pull_completed_at, 1440) ||
      isRecentIso(latestCommand && latestCommand.created_at, 1440)
    );
    const lastSuccessfulPull = successfulBatch && successfulBatch.pull_completed_at
      ? successfulBatch.pull_completed_at
      : null;
    const latestBatchStatus = latestBatch && latestBatch.status
      ? latestBatch.status
      : null;
    const latestPulledEventUtc = firstNonEmpty([
      recentEvents[0] && recentEvents[0].event_time_utc
    ]);
    const latestEventTimeUtc = firstNonEmpty([
      latestPulledEventUtc,
      syncRow && syncRow.last_event_time_utc,
      batchForCounts && batchForCounts.latest_event_time_utc
    ]);
    const selectedDeviceLabel = firstNonEmpty([facts.identifier, facts.deviceUid]) || '-';
    const selectedDeviceSubLabel = firstNonEmpty([facts.host, firstNonEmpty([facts.vendor, facts.model])]) || 'No host or model evidence yet';
    const agentLastSeen = firstNonEmpty([
      agentRow && agentRow.last_seen_at,
      agentRow && agentRow.last_heartbeat_at
    ]);
    const agentId = resolveProgressAgentId(row, evidence);
    const readinessStatusLabelText = readinessStatusLabel(readiness && readiness.readiness_status);
    const validationStatusText = String(readiness && readiness.validation_status || 'never_run');
    const validationReasonText = firstNonEmpty([
      readiness && readiness.validation_reason_code,
      readiness && readiness.readiness_reason
    ]) || '-';
    const validationEvidenceText = summarizeValidationEvidence(readiness && readiness.validation_last_result);
    const actionStatus = actionContext && actionContext.actionEligible ? 'Ready' : 'Not ready';
    const actionReason = actionContext && actionContext.reason ? actionContext.reason : '-';
    const nextActionLabel = actionContext && actionContext.actionType && actionContext.actionType !== 'none'
      ? actionContext.actionLabel
      : 'No action available';
    const nextActionHelp = actionContext && actionContext.actionEligible
      ? 'This action can be run now.'
      : actionReason;
    const hasPulledData = Boolean(recentEvents.length > 0 || batchTotalCount > 0 || lastSuccessfulPull);
    const summary = summarizeLiveViewStatus(
      row,
      facts,
      actionContext,
      latestCommand,
      hasPulledData,
      {
        lastSuccessfulPullAt: lastSuccessfulPull,
        latestBatchPullCompletedAt: latestBatch && latestBatch.pull_completed_at,
        lastSyncCompletedAt: syncRow && syncRow.last_sync_completed_at
      },
      readiness
    );

    const latestRowsHtml = recentEvents.length === 0
      ? '<tr><td colspan="4" class="empty">No pulled data has been received for this device yet.</td></tr>'
      : recentEvents.map(item => {
        const eventUtc = formatDateTime(item && item.event_time_utc);
        const identifier = firstNonEmpty([
          item && item.device_person_id,
          item && item.person_id
        ]) || '-';
        const deviceValue = firstNonEmpty([
          item && item.device_uid
        ]) || '-';
        const verification = firstNonEmpty([
          item && item.verify_state,
          item && item.verify_method,
          item && item.direction
        ]) || '-';
        return (
          '<tr>' +
            '<td>' + escapeHtml(eventUtc) + '</td>' +
            '<td>' + escapeHtml(identifier) + '</td>' +
            '<td>' + escapeHtml(deviceValue) + '</td>' +
            '<td>' + escapeHtml(verification) + '</td>' +
          '</tr>'
        );
      }).join('');

    el.innerHTML =
      '<section class="live-view-selected-strip">' +
        '<div>' +
          '<div class="live-view-selected-title">Selected Device</div>' +
          '<div class="live-view-selected-main">' + escapeHtml(selectedDeviceLabel) + '</div>' +
          '<div class="live-view-selected-sub">' + escapeHtml(selectedDeviceSubLabel) + '</div>' +
        '</div>' +
        '<div class="live-view-selected-badges">' +
          '<span class="' + badgeClass(readinessStatusKind(readiness && readiness.readiness_status)) + '">' + escapeHtml(readinessStatusLabelText) + '</span>' +
          '<span class="' + badgeClass(validationStatusKind(readiness && readiness.validation_status)) + '">' + escapeHtml(validationStatusLabel(validationStatusText)) + '</span>' +
        '</div>' +
      '</section>' +
      '<div class="live-view-top-grid">' +
        '<section class="live-view-summary-card">' +
          '<h4>Quick Status</h4>' +
          '<div class="live-view-summary-grid">' +
            kv('Device in bridge flow', yesNoLabel(summary.deviceInBridgeFlow)) +
            kv('Pull ready now', yesNoLabel(summary.pullReady)) +
            kv('Data received', yesNoLabel(summary.hasData)) +
            kv('Last successful pull', formatDateTime(lastSuccessfulPull)) +
          '</div>' +
          '<div class="live-view-summary-state">' +
            '<span class="' + badgeClass(summary.stateKind) + '">' + escapeHtml(summary.stateLabel) + '</span>' +
            '<span class="live-view-summary-reason">' + escapeHtml(summary.reason) + '</span>' +
          '</div>' +
        '</section>' +
        '<section class="live-view-summary-card">' +
          '<h4>Next Action</h4>' +
          '<div class="live-view-summary-grid">' +
            kv('Action', nextActionLabel) +
            kv('Actionability', actionStatus) +
            kv('Managed status', managedStatusLabel(facts.managedStatus)) +
            kv('Agent context', agentId || '-') +
          '</div>' +
          '<div class="live-view-summary-state">' +
            '<span class="' + badgeClass(actionContext && actionContext.actionEligible ? 'ok' : 'warn') + '">' + escapeHtml(actionContext && actionContext.actionEligible ? 'Actionable' : 'Blocked') + '</span>' +
            '<span class="live-view-summary-reason">' + escapeHtml(nextActionHelp) + '</span>' +
          '</div>' +
        '</section>' +
      '</div>' +
      '<section class="live-view-summary-card">' +
        '<h4>State Meaning</h4>' +
        '<div class="live-view-summary-grid">' +
          kv('Onboarding', readinessStatusLabelText) +
          kv('Validation', validationStatusLabel(validationStatusText)) +
          kv('Pull readiness', pullOperationalLabel(readiness && readiness.readiness_status)) +
          kv('Blocked reason', actionContext && !actionContext.actionEligible ? actionReason : 'None') +
        '</div>' +
      '</section>' +
      '<div class="live-view-grid">' +
        '<section class="live-view-card">' +
          '<h4>Device Configuration & Identity</h4>' +
          '<div class="live-view-card-grid">' +
            kv('Device UID', facts.deviceUid || '-') +
            kv('Provider / Model', firstNonEmpty([facts.vendor, facts.model]) || '-') +
            kv('Firmware', facts.firmware || '-') +
            kv('IP / Host', facts.host || '-') +
            kv('Lifecycle scope', lifecycleScopeLabel(row.lifecycle_scope)) +
            kv('Managed state', managedStatusLabel(facts.managedStatus)) +
            kv('Last seen', formatDateTime(row.last_seen_at)) +
            kv('Manageability', manageabilityLabel(facts.manageabilityStatus)) +
          '</div>' +
        '</section>' +
        '<section class="live-view-card">' +
          '<h4>Validation Result</h4>' +
          '<div class="live-view-card-grid">' +
            kv('Onboarding status', readinessStatusLabelText) +
            kv('Validation status', validationStatusLabel(validationStatusText)) +
            kv('Validation reason', validationReasonText) +
            kv('Validation evidence', validationEvidenceText) +
            kv('Validation completed', formatDateTime(readiness && readiness.validation_completed_at)) +
            kv('Recommended next step', nextActionLabel) +
          '</div>' +
        '</section>' +
        '<section class="live-view-card">' +
          '<h4>Pull Readiness & Agent Evidence</h4>' +
          '<div class="live-view-card-grid">' +
            kv('Pull readiness', pullOperationalLabel(readiness && readiness.readiness_status)) +
            kv('Can pull now', actionStatus) +
            kv('Active managing agent', agentId || '-') +
            kv('Agent last seen', formatDateTime(agentLastSeen)) +
            kv('Last pull command', latestCommand ? (latestCommand.status || '-') : '-') +
            kv('Last sync state', syncRow ? (syncRow.status || '-') : '-') +
            kv('Last batch status', latestBatchStatus || '-') +
            kv('Last successful pull', formatDateTime(lastSuccessfulPull)) +
            kv('Latest event time', formatDateTime(latestEventTimeUtc)) +
            kv('Recent activity (24h)', recentOperationalEvidence ? 'Yes' : 'No') +
            kv('Why blocked', actionContext && !actionContext.actionEligible ? actionReason : 'Not blocked') +
            kv('Last batch rows/events', batchForCounts ? String(batchTotalCount) : '-') +
          '</div>' +
        '</section>' +
      '</div>' +
      '<section class="live-view-table-card">' +
        '<h4>Latest Pulled Data</h4>' +
        '<div class="table-wrap live-view-table-wrap">' +
          '<table class="live-view-table">' +
            '<thead>' +
              '<tr>' +
                '<th>Event time</th>' +
                '<th>Person / User</th>' +
                '<th>Device UID</th>' +
                '<th>Status</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' + latestRowsHtml + '</tbody>' +
          '</table>' +
        '</div>' +
      '</section>' +
      '<div class="validated-note">' + escapeHtml(note) + '</div>';
  }

  function setGlobalStatus(kind, text) {
    const el = byId('globalStatus');
    el.className = 'status card';
    if (kind === 'ok') {
      el.classList.add('status-ok');
    } else if (kind === 'warn') {
      el.classList.add('status-warn');
    } else if (kind === 'err') {
      el.classList.add('status-err');
    } else {
      el.classList.add('status-info');
    }
    el.textContent = text;
  }

  function nowIsoMinusMinutes(minutes) {
    const ms = Date.now() - (minutes * 60 * 1000);
    return new Date(ms).toISOString();
  }

  function formatDateTime(value) {
    if (!value) {
      return '-';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return date.toLocaleString();
  }

  function minutesSince(value) {
    if (!value) {
      return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return Math.floor((Date.now() - date.getTime()) / 60000);
  }

  function badgeClass(kind) {
    if (kind === 'ok') return 'badge badge-ok';
    if (kind === 'warn') return 'badge badge-warn';
    if (kind === 'danger') return 'badge badge-danger';
    return 'badge badge-neutral';
  }

  function classifyAgentStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'active') return 'ok';
    if (value === 'inactive') return 'warn';
    if (value === 'revoked') return 'danger';
    return 'neutral';
  }

  function classifyManageability(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'ingesting' || value === 'manageable') return 'ok';
    if (value === 'reachable' || value === 'protocol_reachable') return 'warn';
    if (value === 'blocked') return 'danger';
    return 'neutral';
  }

  function classifyCommandStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'acknowledged') return 'ok';
    if (value === 'queued' || value === 'sent') return 'warn';
    if (value === 'failed' || value === 'expired') return 'danger';
    return 'neutral';
  }

  function classifySyncStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'idle') return 'ok';
    if (value === 'syncing') return 'warn';
    if (value === 'error') return 'danger';
    return 'neutral';
  }

  function classifyBatchStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'accepted') return 'ok';
    if (value === 'partial') return 'warn';
    if (value === 'rejected') return 'danger';
    return 'neutral';
  }

  function classifyRuntimeHealth(onlineNow, runtime) {
    const stats = runtime || {};
    const attachedDevices = Number(stats.attachedDevices || 0);
    const blockedByRuntime = Number(stats.blockedByRuntime || 0);
    const blockedDevices = Number(stats.blockedDevices || 0);
    const recentFailures24h = Number(stats.recentFailures24h || 0);

    if (!onlineNow) {
      return {
        level: 'offline',
        kind: 'danger',
        label: 'Site runtime offline',
        reason: 'No recent heartbeat was observed for this runtime.'
      };
    }
    if (blockedByRuntime > 0) {
      return {
        level: 'blocked',
        kind: 'danger',
        label: 'Site runtime blocked',
        reason: String(blockedByRuntime) + ' device(s) are blocked because runtime availability is missing.'
      };
    }
    if (recentFailures24h > 0 || blockedDevices > 0) {
      return {
        level: 'degraded',
        kind: 'warn',
        label: 'Site runtime degraded',
        reason: 'Runtime is online but has blocked devices or recent failures that need follow-up.'
      };
    }
    if (attachedDevices === 0) {
      return {
        level: 'unknown',
        kind: 'neutral',
        label: 'Site runtime unknown',
        reason: 'Runtime has no attached bridge devices in the current scope.'
      };
    }
    return {
      level: 'healthy',
      kind: 'ok',
      label: 'Site runtime healthy',
      reason: 'Runtime is online with no blocked devices or recent failures.'
    };
  }

  function deriveDeviceOperationalHealth(row, readiness, actionContext, hasRecentData) {
    const lifecycleScope = normalizeLifecycleScope(row && row.lifecycle_scope);
    const managedStatus = String(row && row.managed_status || '').toLowerCase();
    const readinessStatus = String(readiness && readiness.readiness_status || '').toLowerCase();
    const actionEligible = Boolean(actionContext && actionContext.actionEligible);
    const reason = firstNonEmpty([
      actionContext && actionContext.reason,
      readiness && readiness.readiness_reason
    ]);

    if (lifecycleScope && lifecycleScope !== 'bridge_ops') {
      return {
        label: 'Unknown',
        kind: 'neutral',
        reason: 'Diagnostic-only lifecycle scope; bridge actions are intentionally unavailable.'
      };
    }

    if (readinessStatus === 'managed_blocked_agent_offline') {
      return {
        label: 'Offline',
        kind: 'danger',
        reason: reason || 'Managing agent is offline.'
      };
    }

    if (readinessStatus === 'validation_failed' || readinessStatus === 'candidate_incomplete_configuration') {
      return {
        label: 'Blocked',
        kind: 'danger',
        reason: reason || 'Device is blocked by failed validation or incomplete configuration.'
      };
    }

    if (managedStatus === 'managed' && !actionEligible) {
      return {
        label: 'Blocked',
        kind: 'danger',
        reason: reason || 'Managed device is not actionable in its current state.'
      };
    }

    if (
      readinessStatus === 'candidate_ready_for_validation'
      || readinessStatus === 'validation_succeeded'
      || readinessStatus === 'managed_unbound'
    ) {
      return {
        label: 'Degraded',
        kind: 'warn',
        reason: reason || 'A lifecycle step is still required before this device is fully actionable.'
      };
    }

    if (actionEligible) {
      if (hasRecentData) {
        return {
          label: 'Healthy',
          kind: 'ok',
          reason: 'Device is actionable and has recent pull evidence.'
        };
      }
      return {
        label: 'Degraded',
        kind: 'warn',
        reason: 'Device is actionable but waiting for fresh successful pull evidence.'
      };
    }

    return {
      label: 'Unknown',
      kind: 'neutral',
      reason: reason || 'Operational state is not fully determined from current evidence.'
    };
  }

  function manageabilityLabel(status) {
    const map = {
      unknown: 'Unknown',
      reachable: 'Reachable only',
      protocol_reachable: 'Protocol reachable',
      blocked: 'Blocked',
      manageable: 'Manageable',
      ingesting: 'Ingesting'
    };
    const key = String(status || '').toLowerCase();
    return map[key] || (status || '-');
  }

  function managedStatusLabel(status) {
    const map = {
      candidate: 'Candidate',
      managed: 'Managed',
      inactive: 'Inactive',
      unreachable: 'Unreachable'
    };
    const key = String(status || '').toLowerCase();
    return map[key] || (status || '-');
  }

  function remediationLabel(status) {
    if (String(status || '').toLowerCase() === 'needs_field_action') {
      return 'Needs field action';
    }
    return 'None';
  }

  function actionHint(row) {
    const lifecycleScope = normalizeLifecycleScope(row && row.lifecycle_scope);
    const manual = String(row && row.remediation_manual_status || '').toLowerCase();
    const manageability = String(row && row.manageability_status || '').toLowerCase();
    const managed = String(row && row.managed_status || '').toLowerCase();
    if (lifecycleScope && lifecycleScope !== 'bridge_ops') {
      return 'Diagnostic row only; bridge operational actions are disabled in this scope.';
    }
    if (manual === 'needs_field_action') {
      return 'Coordinate onsite remediation.';
    }
    if (managed === 'candidate') {
      return 'Claim candidate to enable managed lifecycle operations.';
    }
    if (managed === 'managed') {
      return 'Queue pull through Local Agent when operational eligibility is met.';
    }
    if (manageability === 'blocked') {
      return 'Check credentials/connectivity and retry pull.';
    }
    if (manageability === 'reachable' || manageability === 'protocol_reachable') {
      return 'Validate protocol/auth before relying on ingestion.';
    }
    if (manageability === 'ingesting') {
      return 'Ingestion healthy; monitor freshness.';
    }
    return 'Monitor state.';
  }

  function formatSamples(samples) {
    if (!Array.isArray(samples) || samples.length === 0) {
      return '-';
    }
    return samples.slice(0, 3).map(item => {
      const code = item && item.code ? item.code : 'unknown';
      const id = item && item.device_person_id ? item.device_person_id : '-';
      const time = item && item.event_time_utc ? item.event_time_utc : '-';
      return code + ' [' + id + '] ' + time;
    }).join('\n');
  }

  function isWithinHours(value, hours) {
    const minutes = minutesSince(value);
    if (minutes === null) {
      return false;
    }
    return minutes <= (hours * 60);
  }

  function resolveDeviceRuntimeAgentId(row, readiness) {
    return firstNonEmpty([
      readiness && readiness.active_binding && readiness.active_binding.agent_id,
      readiness && readiness.managing_agent && readiness.managing_agent.id,
      row && row.last_agent_id,
      row && row.discovered_by_agent_id,
      row && row.agent_id
    ]);
  }

  function extractRuntimeSiteLabel(agentRow) {
    const metadata = parseObject(agentRow && agentRow.metadata);
    const siteContext = parseObject(metadata.site_context);
    return firstNonEmpty([
      metadata.site_label,
      metadata.site_name,
      siteContext.site_label,
      siteContext.site_name,
      metadata.network_label,
      metadata.location
    ]) || 'Site context not configured';
  }

  async function loadOverview() {
    const cfg = getConfig();
    const companyId = cfg.companyId;
    const onlineSeenSince = nowIsoMinusMinutes(state.onlineWindowMinutes);

    const [onlineAgents, activeAgents, blockedDevices, needsAction, failedCommands, expiredCommands, syncStates, batchesPayload] = await Promise.all([
      apiGet('/api/agent-admin/agents', { company_id: companyId, status: 'active', seen_since: onlineSeenSince, limit: 200 }),
      apiGet('/api/agent-admin/agents', { company_id: companyId, status: 'active', limit: 200 }),
      apiGet('/api/devices', { company_id: companyId, manageability_status: 'blocked', limit: 200 }),
      apiGet('/api/devices', { company_id: companyId, remediation_manual_status: 'needs_field_action', limit: 200 }),
      apiGet('/api/agent-admin/commands', { company_id: companyId, status: 'failed', limit: 200 }),
      apiGet('/api/agent-admin/commands', { company_id: companyId, status: 'expired', limit: 200 }),
      apiGet('/api/agent-admin/device-sync-states', { company_id: companyId, limit: 200 }),
      apiGet('/api/agent-admin/device-event-batches', { company_id: companyId, limit: 200 })
    ]);

    const onlineRows = extractRows(onlineAgents);
    const activeRows = extractRows(activeAgents);
    const blockedRows = extractRows(blockedDevices);
    const needsActionRows = extractRows(needsAction);
    const failedRows = extractRows(failedCommands);
    const expiredRows = extractRows(expiredCommands);
    const syncRows = extractRows(syncStates);
    const batchRows = extractRows(batchesPayload);
    const rejectedRows = batchRows.filter(row => String(row && row.status || '').toLowerCase() === 'rejected');
    const successfulBatchRows = batchRows.filter(row => {
      const status = String(row && row.status || '').toLowerCase();
      return status === 'accepted' || status === 'partial';
    });
    const syncErrorRows = syncRows.filter(row => String(row && row.status || '').toLowerCase() === 'error');
    const offlineRuntimeCount = activeRows.filter(row => {
      const heartbeat = firstNonEmpty([row && row.last_seen_at, row && row.last_heartbeat_at]);
      return !isRecentIso(heartbeat, state.onlineWindowMinutes);
    }).length;
    const failedStale = failedRows.length + expiredRows.length + syncErrorRows.length + rejectedRows.length;

    byId('metricAgentsOnline').textContent = String(onlineRows.length);
    const offlineOverviewMetric = byId('metricRuntimesOfflineOverview');
    if (offlineOverviewMetric) {
      offlineOverviewMetric.textContent = String(offlineRuntimeCount);
    }
    byId('metricBlockedDevices').textContent = String(blockedRows.length);
    byId('metricNeedsFieldAction').textContent = String(needsActionRows.length);
    byId('metricFailedStale').textContent = String(failedStale);

    const attentionItems = [];
    if (offlineRuntimeCount > 0) {
      attentionItems.push({
        severity: 'offline',
        title: String(offlineRuntimeCount) + ' site runtime(s) offline',
        detail: 'At least one active runtime has no recent heartbeat.',
        nextStep: 'Check local agent process/service health and network path to SaaS.'
      });
    }
    blockedRows.slice(0, 3).forEach(row => {
      attentionItems.push({
        severity: 'blocked',
        title: 'Blocked device: ' + (row.device_uid || '-'),
        detail: 'Reason: ' + (row.manageability_reason || 'unknown') + '.',
        nextStep: 'Validate credentials/connectivity, then retry pull.'
      });
    });
    needsActionRows.slice(0, 3).forEach(row => {
      attentionItems.push({
        severity: 'degraded',
        title: 'Field action required: ' + (row.device_uid || '-'),
        detail: 'Owner: ' + (row.remediation_manual_owner || 'unassigned') + '. Note: ' + (row.remediation_manual_note || 'none'),
        nextStep: 'Coordinate onsite remediation and update note/owner.'
      });
    });
    failedRows.slice(0, 2).forEach(row => {
      const deviceUid = row && row.command_payload && row.command_payload.device_uid
        ? row.command_payload.device_uid
        : '-';
      attentionItems.push({
        severity: 'degraded',
        title: 'Failed command on ' + deviceUid,
        detail: 'Failure: ' + (row.failure_reason || 'unknown') + '.',
        nextStep: 'Review command lifecycle evidence and requeue only after root cause is clear.'
      });
    });
    syncErrorRows.slice(0, 2).forEach(row => {
      attentionItems.push({
        severity: 'degraded',
        title: 'Sync state error: ' + (row.device_uid || '-'),
        detail: 'Failure: ' + (row.failure_reason || 'unknown') + '.',
        nextStep: 'Inspect last command + batch result for this device and recover from the latest confirmed cursor.'
      });
    });
    rejectedRows.slice(0, 2).forEach(row => {
      attentionItems.push({
        severity: 'degraded',
        title: 'Rejected batch: ' + (row.device_uid || '-'),
        detail: 'Rejected rows: ' + toCount(row && row.rejected_count) + '.',
        nextStep: 'Review rejection samples and correct device/identity mapping inputs before retry.'
      });
    });
    if (attentionItems.length === 0 && successfulBatchRows.length > 0) {
      attentionItems.push({
        severity: 'info',
        title: 'No urgent blockers detected',
        detail: 'Recent successful pull evidence is present.',
        nextStep: 'Continue routine monitoring and queue pulls as needed.'
      });
    }

    const attentionList = byId('attentionList');
    if (attentionItems.length === 0) {
      attentionList.innerHTML = '<li class="empty">No critical issues detected in current sample.</li>';
    } else {
      attentionList.innerHTML = attentionItems.map(item => (
        '<li class="attention-item attention-item--' + escapeHtml(item.severity || 'degraded') + '">' +
          '<div class="attention-item-head">' +
            '<div class="attention-item-title">' + escapeHtml(item.title) + '</div>' +
            '<span class="attention-severity ' + escapeHtml(item.severity || 'degraded') + '">' + escapeHtml(item.severity || 'degraded') + '</span>' +
          '</div>' +
          '<div class="attention-item-sub">' + escapeHtml(item.detail) + '</div>' +
          '<div class="attention-item-sub"><strong>Next step:</strong> ' + escapeHtml(item.nextStep || 'Review details and take the next lifecycle action.') + '</div>' +
        '</li>'
      )).join('');
    }

    const recentSignals = [];
    failedRows.forEach(row => {
      const deviceUid = firstNonEmpty([
        row && row.command_payload && row.command_payload.device_uid
      ]) || '-';
      recentSignals.push({
        signal: 'Pull command',
        outcome: 'Failed',
        outcomeKind: 'danger',
        scope: deviceUid,
        when: firstNonEmpty([row && row.acknowledged_at, row && row.sent_at, row && row.created_at]),
        reason: firstNonEmpty([row && row.failure_reason, 'Unknown failure'])
      });
    });
    expiredRows.forEach(row => {
      const deviceUid = firstNonEmpty([
        row && row.command_payload && row.command_payload.device_uid
      ]) || '-';
      recentSignals.push({
        signal: 'Pull command',
        outcome: 'Expired',
        outcomeKind: 'danger',
        scope: deviceUid,
        when: firstNonEmpty([row && row.expires_at, row && row.created_at]),
        reason: firstNonEmpty([row && row.failure_reason, 'Command expired before completion'])
      });
    });
    syncErrorRows.forEach(row => {
      recentSignals.push({
        signal: 'Sync state',
        outcome: 'Error',
        outcomeKind: 'danger',
        scope: firstNonEmpty([row && row.device_uid]) || '-',
        when: firstNonEmpty([row && row.last_sync_completed_at, row && row.updated_at]),
        reason: firstNonEmpty([row && row.failure_reason, 'Sync state reports an error'])
      });
    });
    rejectedRows.forEach(row => {
      recentSignals.push({
        signal: 'Batch ingestion',
        outcome: 'Rejected',
        outcomeKind: 'danger',
        scope: firstNonEmpty([row && row.device_uid]) || '-',
        when: firstNonEmpty([row && row.pull_completed_at, row && row.created_at]),
        reason: firstNonEmpty([
          row && row.failure_reason,
          toCount(row && row.rejected_count) > 0
            ? (String(toCount(row && row.rejected_count)) + ' row(s) rejected')
            : 'Rejected batch'
        ])
      });
    });
    successfulBatchRows.forEach(row => {
      const status = String(row && row.status || '').toLowerCase();
      recentSignals.push({
        signal: 'Batch ingestion',
        outcome: status === 'accepted' ? 'Accepted' : 'Partial',
        outcomeKind: status === 'accepted' ? 'ok' : 'warn',
        scope: firstNonEmpty([row && row.device_uid]) || '-',
        when: firstNonEmpty([row && row.pull_completed_at, row && row.created_at]),
        reason: status === 'accepted'
          ? 'Batch accepted successfully'
          : 'Batch partially accepted; review rejection samples if needed'
      });
    });

    recentSignals.sort((a, b) => {
      const aTime = timestampMs(a.when) || 0;
      const bTime = timestampMs(b.when) || 0;
      return bTime - aTime;
    });

    const signalsBody = byId('overviewSignalsBody');
    if (recentSignals.length === 0) {
      signalsBody.innerHTML = '<tr><td colspan="5" class="empty">No recent operational signals.</td></tr>';
    } else {
      signalsBody.innerHTML = recentSignals.slice(0, 12).map(row => (
        '<tr>' +
          '<td>' + escapeHtml(row.signal || '-') + '</td>' +
          '<td><span class="' + badgeClass(row.outcomeKind || 'neutral') + '">' + escapeHtml(row.outcome || '-') + '</span></td>' +
          '<td>' + escapeHtml(row.scope || '-') + '</td>' +
          '<td>' + escapeHtml(formatDateTime(row.when)) + '</td>' +
          '<td>' + escapeHtml(row.reason || '-') + '</td>' +
        '</tr>'
      )).join('');
    }
  }

  async function loadAgents() {
    const cfg = getConfig();
    const [agentsPayload, devicesPayload, commandsPayload, batchesPayload] = await Promise.all([
      apiGet('/api/agent-admin/agents', {
        company_id: cfg.companyId,
        status: byId('agentsStatus').value,
        seen_since: byId('agentsSeenSince').value,
        limit: byId('agentsLimit').value
      }),
      apiGet('/api/devices', {
        company_id: cfg.companyId,
        lifecycle_scope: 'bridge_ops',
        limit: 300
      }),
      apiGet('/api/agent-admin/commands', {
        company_id: cfg.companyId,
        limit: 400
      }),
      apiGet('/api/agent-admin/device-event-batches', {
        company_id: cfg.companyId,
        limit: 400
      })
    ]);

    const rows = extractRows(agentsPayload);
    const devicesRows = extractRows(devicesPayload);
    const commandRows = extractRows(commandsPayload);
    const batchRows = extractRows(batchesPayload);
    const readinessByDeviceUid = await loadDevicesReadinessMap(cfg.companyId, devicesRows, 200);

    const runtimeByAgentId = {};
    rows.forEach(row => {
      const agentId = firstNonEmpty([row && row.id]);
      if (!agentId) {
        return;
      }
      runtimeByAgentId[agentId] = {
        attachedDevices: 0,
        blockedDevices: 0,
        blockedByRuntime: 0,
        pullReadyDevices: 0,
        recentCommands24h: 0,
        recentValidations24h: 0,
        recentPulls24h: 0,
        recentFailures24h: 0,
        latestSuccessAt: null,
        latestFailureAt: null,
        latestFailureReason: ''
      };
    });

    devicesRows.forEach(row => {
      const deviceUid = firstNonEmpty([row && row.device_uid]);
      const readiness = readinessByDeviceUid[deviceUid] || null;
      const mappedAgentId = resolveDeviceRuntimeAgentId(row, readiness);
      const runtime = runtimeByAgentId[mappedAgentId];
      if (!runtime) {
        return;
      }
      runtime.attachedDevices += 1;
      const readinessStatus = String(readiness && readiness.readiness_status || '').toLowerCase();
      const manageabilityStatus = String(row && row.manageability_status || '').toLowerCase();
      if (readinessStatus === 'managed_pull_ready') {
        runtime.pullReadyDevices += 1;
      }
      if (manageabilityStatus === 'blocked' || readinessStatus === 'managed_blocked_agent_offline') {
        runtime.blockedDevices += 1;
      }
      if (readinessStatus === 'managed_blocked_agent_offline') {
        runtime.blockedByRuntime += 1;
      }
    });

    commandRows.forEach(row => {
      const agentId = firstNonEmpty([row && row.agent_id]);
      const runtime = runtimeByAgentId[agentId];
      if (!runtime) {
        return;
      }
      if (!isWithinHours(row && row.created_at, 24)) {
        return;
      }
      runtime.recentCommands24h += 1;
      const commandType = String(row && row.command_type || '').toUpperCase();
      if (commandType === 'VALIDATE_DEVICE_CANDIDATE') {
        runtime.recentValidations24h += 1;
      }
      const commandStatus = String(row && row.status || '').toLowerCase();
      if (commandStatus === 'failed' || commandStatus === 'expired') {
        runtime.recentFailures24h += 1;
        const when = firstNonEmpty([
          row && row.acknowledged_at,
          row && row.sent_at,
          row && row.expires_at,
          row && row.created_at
        ]);
        const whenMs = timestampMs(when);
        const currentFailureMs = timestampMs(runtime.latestFailureAt);
        if (whenMs !== null && (currentFailureMs === null || whenMs > currentFailureMs)) {
          runtime.latestFailureAt = when;
          runtime.latestFailureReason = firstNonEmpty([
            row && row.failure_reason,
            commandStatus === 'expired' ? 'Command expired before completion' : 'Command failed'
          ]);
        }
      }
    });

    batchRows.forEach(row => {
      const agentId = firstNonEmpty([row && row.agent_id]);
      const runtime = runtimeByAgentId[agentId];
      if (!runtime) {
        return;
      }
      const status = String(row && row.status || '').toLowerCase();
      if ((status === 'accepted' || status === 'partial') && isWithinHours(row && row.pull_completed_at, 24)) {
        runtime.recentPulls24h += 1;
        const successWhen = firstNonEmpty([row && row.pull_completed_at, row && row.created_at]);
        const successWhenMs = timestampMs(successWhen);
        const currentSuccessMs = timestampMs(runtime.latestSuccessAt);
        if (successWhenMs !== null && (currentSuccessMs === null || successWhenMs > currentSuccessMs)) {
          runtime.latestSuccessAt = successWhen;
        }
      }
      if (status === 'rejected' && isWithinHours(firstNonEmpty([row && row.pull_completed_at, row && row.created_at]), 24)) {
        runtime.recentFailures24h += 1;
        const failureWhen = firstNonEmpty([row && row.pull_completed_at, row && row.created_at]);
        const failureWhenMs = timestampMs(failureWhen);
        const currentFailureMs = timestampMs(runtime.latestFailureAt);
        if (failureWhenMs !== null && (currentFailureMs === null || failureWhenMs > currentFailureMs)) {
          runtime.latestFailureAt = failureWhen;
          runtime.latestFailureReason = firstNonEmpty([
            row && row.failure_reason,
            toCount(row && row.rejected_count) > 0
              ? (String(toCount(row && row.rejected_count)) + ' row(s) rejected')
              : 'Batch rejected'
          ]);
        }
      }
    });

    const runtimeRows = rows.map(row => {
      const agentId = firstNonEmpty([row && row.id]);
      const runtime = runtimeByAgentId[agentId] || {
        attachedDevices: 0,
        blockedDevices: 0,
        blockedByRuntime: 0,
        pullReadyDevices: 0,
        recentCommands24h: 0,
        recentValidations24h: 0,
        recentPulls24h: 0,
        recentFailures24h: 0,
        latestSuccessAt: null,
        latestFailureAt: null,
        latestFailureReason: ''
      };
      const heartbeat = firstNonEmpty([
        row && row.last_seen_at,
        row && row.last_heartbeat_at
      ]);
      const status = String(row && row.status || '').toLowerCase();
      const onlineNow = status === 'active' && isRecentIso(heartbeat, state.onlineWindowMinutes);
      return {
        row,
        runtime,
        heartbeat,
        onlineNow
      };
    });

    const metricOnline = runtimeRows.filter(item => item.onlineNow).length;
    const metricOffline = Math.max(0, runtimeRows.length - metricOnline);
    const metricAttached = runtimeRows.reduce((sum, item) => sum + item.runtime.attachedDevices, 0);
    const metricActionable = runtimeRows.reduce((sum, item) => (
      sum + (item.onlineNow ? item.runtime.pullReadyDevices : 0)
    ), 0);

    const metricOnlineEl = byId('metricRuntimesOnline');
    const metricOfflineEl = byId('metricRuntimesOffline');
    const metricAttachedEl = byId('metricRuntimeDevicesAttached');
    const metricActionableEl = byId('metricRuntimeActionable');
    if (metricOnlineEl) {
      metricOnlineEl.textContent = String(metricOnline);
    }
    if (metricOfflineEl) {
      metricOfflineEl.textContent = String(metricOffline);
    }
    if (metricAttachedEl) {
      metricAttachedEl.textContent = String(metricAttached);
    }
    if (metricActionableEl) {
      metricActionableEl.textContent = String(metricActionable);
    }

    const body = byId('agentsBody');
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="10" class="empty">No site runtimes matched current filters.</td></tr>';
      return;
    }

    body.innerHTML = runtimeRows.map(item => {
      const row = item.row;
      const runtime = item.runtime;
      const metadata = parseObject(row && row.metadata);
      const runtimeName = firstNonEmpty([row && row.agent_name, row && row.id]) || '-';
      const runtimeSiteLabel = extractRuntimeSiteLabel(row);
      const versionLabel = firstNonEmpty([
        metadata.agent_version,
        metadata.version,
        row && row.version
      ]) || 'Version unknown';
      const runtimeHealth = classifyRuntimeHealth(item.onlineNow, runtime);
      const healthLabel = runtimeHealth.label;
      const healthKind = runtimeHealth.kind;
      const actionableNow = item.onlineNow && runtime.pullReadyDevices > 0;
      const attentionReasons = [];
      attentionReasons.push(runtimeHealth.reason);
      if (runtime.attachedDevices === 0) {
        attentionReasons.push('No attached devices');
      }
      if (runtime.blockedByRuntime > 0) {
        attentionReasons.push(String(runtime.blockedByRuntime) + ' blocked by runtime');
      } else if (runtime.blockedDevices > 0) {
        attentionReasons.push(String(runtime.blockedDevices) + ' blocked devices');
      }
      const attentionText = attentionReasons.length > 0
        ? attentionReasons.join('; ')
        : 'No immediate action required';
      const recentActivityText = runtime.recentPulls24h + ' pulls, '
        + runtime.recentValidations24h + ' validations, '
        + runtime.recentCommands24h + ' commands (24h)';
      const recentHistoryText = 'Last success: ' + formatDateTime(runtime.latestSuccessAt)
        + ' | Last failure: ' + formatDateTime(runtime.latestFailureAt);
      const failureContextText = runtime.latestFailureReason
        ? ('Recent failure: ' + runtime.latestFailureReason)
        : 'No recent failure reason captured.';

      return (
        '<tr>' +
          '<td>' +
            '<div class="device-cell-title">' + escapeHtml(runtimeName) + '</div>' +
            '<div class="device-cell-sub">' + escapeHtml(runtimeSiteLabel) + '</div>' +
            '<div class="device-cell-sub">' + escapeHtml(versionLabel) + '</div>' +
          '</td>' +
          '<td><span class="' + badgeClass(healthKind) + '">' + escapeHtml(healthLabel) + '</span></td>' +
          '<td>' + escapeHtml(formatDateTime(item.heartbeat)) + '</td>' +
          '<td>' + escapeHtml(String(runtime.attachedDevices)) + '</td>' +
          '<td>' + escapeHtml(String(runtime.pullReadyDevices)) + '</td>' +
          '<td>' + escapeHtml(String(runtime.blockedDevices)) + '</td>' +
          '<td>' +
            '<div>' + escapeHtml(recentActivityText) + '</div>' +
            '<div class="device-cell-sub">' + escapeHtml(recentHistoryText) + '</div>' +
          '</td>' +
          '<td><span class="' + badgeClass(actionableNow ? 'ok' : 'warn') + '">' + escapeHtml(actionableNow ? 'Actionable devices available' : 'No actionable devices now') + '</span></td>' +
          '<td>' +
            '<div>' + escapeHtml(attentionText) + '</div>' +
            '<div class="device-cell-sub">' + escapeHtml(failureContextText) + '</div>' +
          '</td>' +
          '<td>' + escapeHtml(row.id || '-') + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  async function loadDevicesReadinessMap(companyId, rows, maxRows) {
    const readinessByDeviceUid = {};
    const candidates = Array.isArray(rows) ? rows.filter(row => row && row.device_uid) : [];
    if (candidates.length === 0) {
      return readinessByDeviceUid;
    }
    const parsedMaxRows = Number(maxRows);
    const maxReadinessRows = Number.isFinite(parsedMaxRows) && parsedMaxRows > 0
      ? Math.floor(parsedMaxRows)
      : 40;
    const scoped = candidates.slice(0, maxReadinessRows);
    const results = await Promise.allSettled(scoped.map(row => (
      apiGet('/api/agent-admin/devices/' + encodeURIComponent(row.device_uid) + '/onboarding-readiness', {
        company_id: companyId,
        online_window_minutes: state.onlineWindowMinutes
      })
    )));

    results.forEach((result, index) => {
      const row = scoped[index];
      const uid = row && row.device_uid ? String(row.device_uid) : '';
      if (!uid) {
        return;
      }
      if (result.status === 'fulfilled' && result.value && typeof result.value === 'object') {
        readinessByDeviceUid[uid] = result.value;
      }
    });

    return readinessByDeviceUid;
  }

  async function loadDeviceActivitySummaryMap(companyId) {
    const [batchesPayload, syncPayload, commandsPayload] = await Promise.all([
      apiGet('/api/agent-admin/device-event-batches', {
        company_id: companyId,
        limit: 300
      }),
      apiGet('/api/agent-admin/device-sync-states', {
        company_id: companyId,
        limit: 300
      }),
      apiGet('/api/agent-admin/commands', {
        company_id: companyId,
        limit: 300
      })
    ]);

    const summary = {};
    const ensure = (deviceUid) => {
      const key = String(deviceUid || '').trim();
      if (!key) {
        return null;
      }
      if (!summary[key]) {
        summary[key] = {
          latestBatch: null,
          latestSuccessfulBatch: null,
          latestSync: null,
          latestPullCommand: null
        };
      }
      return summary[key];
    };

    const batches = extractRows(batchesPayload);
    batches.forEach(row => {
      const bucket = ensure(row && row.device_uid);
      if (!bucket) {
        return;
      }
      if (!bucket.latestBatch) {
        bucket.latestBatch = row;
      }
      const status = String(row && row.status || '').toLowerCase();
      if (!bucket.latestSuccessfulBatch && (status === 'accepted' || status === 'partial')) {
        bucket.latestSuccessfulBatch = row;
      }
    });

    const syncRows = extractRows(syncPayload);
    syncRows.forEach(row => {
      const bucket = ensure(row && row.device_uid);
      if (!bucket) {
        return;
      }
      if (!bucket.latestSync) {
        bucket.latestSync = row;
      }
    });

    const commandRows = extractRows(commandsPayload);
    commandRows.forEach(row => {
      const commandType = String(row && row.command_type || '').toUpperCase();
      if (commandType !== 'PULL_DEVICE_EVENTS') {
        return;
      }
      const payload = row && row.command_payload ? row.command_payload : {};
      const bucket = ensure(payload && payload.device_uid);
      if (!bucket) {
        return;
      }
      if (!bucket.latestPullCommand) {
        bucket.latestPullCommand = row;
      }
    });

    return summary;
  }

  function pullOperationalLabel(readinessStatus) {
    const key = String(readinessStatus || '').trim().toLowerCase();
    const labels = {
      managed_pull_ready: 'Pull ready',
      managed_unbound: 'Managed - bind required',
      managed_blocked_agent_offline: 'Managed - agent offline',
      validation_succeeded: 'Claim required',
      validation_failed: 'Validation failed',
      candidate_ready_for_validation: 'Ready for validation',
      candidate_incomplete_configuration: 'Incomplete configuration'
    };
    return labels[key] || 'Live status unknown';
  }

  async function loadDevices() {
    const cfg = getConfig();
    const lifecycleScopeFilter = getDevicesLifecycleScopeFilterValue();
    const data = await apiGet('/api/devices', {
      company_id: cfg.companyId,
      device_uid: byId('devicesUid').value,
      managed_status: byId('devicesManagedStatus').value,
      manageability_status: byId('devicesManageabilityStatus').value,
      remediation_manual_status: byId('devicesRemediationStatus').value,
      lifecycle_scope: lifecycleScopeFilter === 'all' ? '' : lifecycleScopeFilter,
      limit: byId('devicesLimit').value
    });
    const rows = extractRows(data);
    const body = byId('devicesBody');
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="11" class="empty">No devices yet. Start with manual onboarding to register the first candidate.</td></tr>';
      renderValidatedProgressEmpty('No devices matched current filters.');
      clearProgressContext('No device available for claim/queue action.');
      state.selectedDeviceUid = '';
      return;
    }

    const [readinessResult, activityResult] = await Promise.allSettled([
      loadDevicesReadinessMap(cfg.companyId, rows),
      loadDeviceActivitySummaryMap(cfg.companyId)
    ]);
    const readinessByDeviceUid = readinessResult.status === 'fulfilled'
      ? (readinessResult.value || {})
      : {};
    const activitySummaryByDeviceUid = activityResult.status === 'fulfilled'
      ? (activityResult.value || {})
      : {};

    const focusedDeviceUid = firstNonEmpty([
      state.selectedDeviceUid,
      byId('devicesUid').value
    ]);
    const candidate = pickProgressDevice(rows, focusedDeviceUid);
    const selectedDeviceUid = candidate && candidate.device_uid
      ? String(candidate.device_uid)
      : '';
    state.selectedDeviceUid = selectedDeviceUid;

    const actionContextByDeviceUid = {};
    body.innerHTML = rows.map(row => {
      const deviceUid = firstNonEmpty([row && row.device_uid]);
      const facts = extractDeviceFacts(row);
      const readiness = readinessByDeviceUid[deviceUid] || null;
      const summary = activitySummaryByDeviceUid[deviceUid] || {};
      const latestBatch = summary.latestBatch || null;
      const successfulBatch = summary.latestSuccessfulBatch || null;
      const latestSync = summary.latestSync || null;
      const latestCommand = summary.latestPullCommand || null;
      const actionContext = deriveProgressActionContext(row, {
        readiness,
        syncRow: latestSync,
        latestCommand
      }, cfg.companyId);
      actionContextByDeviceUid[deviceUid] = actionContext;

      const readinessStatus = readiness ? readiness.readiness_status : '';
      const validationStatus = readiness ? readiness.validation_status : '';
      const validationStatusKey = String(validationStatus || '').toLowerCase();
      const validationReason = readiness
        ? firstNonEmpty([
          readiness.validation_reason_code,
          readiness.readiness_reason
        ])
        : '';
      const lastSuccessfulPullAt = successfulBatch && successfulBatch.pull_completed_at
        ? successfulBatch.pull_completed_at
        : null;
      const batchTotalCount = latestBatch
        ? toCount(latestBatch.inserted_count) + toCount(latestBatch.deduped_count) + toCount(latestBatch.rejected_count)
        : 0;
      const hasRecentData = Boolean(
        successfulBatch
        && (toCount(successfulBatch.inserted_count) + toCount(successfulBatch.deduped_count)) > 0
      );
      const latestCommandStatus = String(latestCommand && latestCommand.status || '').toLowerCase();
      const latestBatchStatus = String(latestBatch && latestBatch.status || '').toLowerCase();
      const commandFailureReason = (latestCommandStatus === 'failed' || latestCommandStatus === 'expired')
        ? firstNonEmpty([
          latestCommand && latestCommand.failure_reason,
          latestCommandStatus === 'expired' ? 'Command expired before completion' : 'Command failed'
        ])
        : '';
      const commandFailureAt = (latestCommandStatus === 'failed' || latestCommandStatus === 'expired')
        ? firstNonEmpty([
          latestCommand && latestCommand.acknowledged_at,
          latestCommand && latestCommand.sent_at,
          latestCommand && latestCommand.expires_at,
          latestCommand && latestCommand.created_at
        ])
        : '';
      const batchFailureReason = latestBatchStatus === 'rejected'
        ? firstNonEmpty([
          latestBatch && latestBatch.failure_reason,
          toCount(latestBatch && latestBatch.rejected_count) > 0
            ? (String(toCount(latestBatch && latestBatch.rejected_count)) + ' row(s) rejected')
            : 'Rejected batch'
        ])
        : '';
      const batchFailureAt = latestBatchStatus === 'rejected'
        ? firstNonEmpty([latestBatch && latestBatch.pull_completed_at, latestBatch && latestBatch.created_at])
        : '';
      const validationFailureReason = validationStatusKey === 'failed'
        ? validationReason
        : '';
      const validationFailureAt = validationStatusKey === 'failed'
        ? firstNonEmpty([readiness && readiness.validation_completed_at])
        : '';
      const latestFailureReason = firstNonEmpty([
        commandFailureReason,
        batchFailureReason,
        validationFailureReason
      ]);
      const latestFailureAt = firstNonEmpty([
        commandFailureAt,
        batchFailureAt,
        validationFailureAt
      ]);
      const liveHealth = deriveDeviceOperationalHealth(row, readiness, actionContext, hasRecentData);
      const liveStatusLabel = liveHealth.label;
      const liveStatusReason = liveHealth.reason;
      const isSelected = selectedDeviceUid && deviceUid === selectedDeviceUid;
      const managingAgentContext = firstNonEmpty([
        readiness && readiness.active_binding && readiness.active_binding.agent_id,
        readiness && readiness.managing_agent && readiness.managing_agent.name,
        readiness && readiness.managing_agent && readiness.managing_agent.id,
        row && row.last_agent_id,
        row && row.discovered_by_agent_id
      ]);
      const providerLabel = firstNonEmpty([
        facts.vendor,
        row && row.provider
      ]) || '-';
      const modelLabel = firstNonEmpty([facts.model, facts.firmware]) || '-';
      const nextActionLabel = actionContext && actionContext.actionType && actionContext.actionType !== 'none'
        ? actionContext.actionLabel
        : 'No action';

      return (
        '<tr class="' + (isSelected ? 'device-row-selected' : '') + '">' +
          '<td>' +
            '<button class="device-select-btn" type="button" data-device-uid="' + escapeHtml(deviceUid) + '">' + escapeHtml(isSelected ? 'Selected' : 'Open') + '</button>' +
          '</td>' +
          '<td>' +
            '<div class="device-cell-title">' + escapeHtml(facts.label || deviceUid || '-') + '</div>' +
            '<div class="device-cell-sub">' + escapeHtml(deviceUid || '-') + '</div>' +
            '<div class="device-cell-sub">' + escapeHtml(firstNonEmpty([facts.identifier, facts.host]) || 'No identifier yet') + '</div>' +
          '</td>' +
          '<td>' +
            '<div class="device-cell-title">' + escapeHtml(providerLabel) + '</div>' +
            '<div class="device-cell-sub">' + escapeHtml(modelLabel) + '</div>' +
          '</td>' +
          '<td>' +
            '<span class="' + badgeClass(readinessStatusKind(readinessStatus)) + '">' + escapeHtml(readinessStatus ? readinessStatusLabel(readinessStatus) : managedStatusLabel(row.managed_status)) + '</span>' +
            '<div class="device-cell-sub">' + escapeHtml(lifecycleScopeLabel(row.lifecycle_scope)) + '</div>' +
          '</td>' +
          '<td>' +
            '<span class="' + badgeClass(validationStatusKind(validationStatus)) + '">' + escapeHtml(validationStatusLabel(validationStatus || 'never_run')) + '</span>' +
            '<div class="device-cell-sub">' + escapeHtml(validationReason || '-') + '</div>' +
          '</td>' +
          '<td>' +
            '<span class="' + badgeClass(readinessStatusKind(readinessStatus)) + '">' + escapeHtml(pullOperationalLabel(readinessStatus)) + '</span>' +
            '<div class="device-cell-sub">' + escapeHtml('Agent: ' + (managingAgentContext || 'Not linked')) + '</div>' +
          '</td>' +
          '<td>' + escapeHtml(formatDateTime(lastSuccessfulPullAt)) + '</td>' +
          '<td>' +
            '<span class="' + badgeClass(hasRecentData ? 'ok' : 'warn') + '">' + escapeHtml(hasRecentData ? 'Recent data received' : 'No recent data') + '</span>' +
            '<div class="device-cell-sub">' + escapeHtml(batchTotalCount > 0 ? ('Last batch rows: ' + batchTotalCount) : 'No recent batch rows') + '</div>' +
            '<div class="device-cell-sub">' + escapeHtml(latestFailureReason
              ? ('Latest failure: ' + latestFailureReason + (latestFailureAt ? (' @ ' + formatDateTime(latestFailureAt)) : ''))
              : 'No recent failure signal') + '</div>' +
          '</td>' +
          '<td>' +
            '<span class="' + badgeClass(actionContext && actionContext.actionEligible ? 'ok' : 'warn') + '">' + escapeHtml(nextActionLabel) + '</span>' +
            '<div class="device-cell-sub">' + escapeHtml(actionContext && actionContext.reason ? actionContext.reason : '-') + '</div>' +
          '</td>' +
          '<td>' +
            '<span class="' + badgeClass(liveHealth.kind) + '">' + escapeHtml(liveStatusLabel) + '</span>' +
            '<div class="device-cell-sub">' + escapeHtml(liveStatusReason) + '</div>' +
            '<div class="device-cell-sub">' + escapeHtml('Manageability: ' + manageabilityLabel(row.manageability_status)) + '</div>' +
          '</td>' +
          '<td>' + escapeHtml(formatDateTime(row.updated_at)) + '</td>' +
        '</tr>'
      );
    }).join('');

    body.querySelectorAll('.device-select-btn').forEach(button => {
      button.addEventListener('click', () => {
        state.selectedDeviceUid = String(button.getAttribute('data-device-uid') || '').trim();
        loadDevices().catch(err => setGlobalStatus('err', 'Devices load failed: ' + err.message));
      });
    });

    if (!candidate) {
      renderValidatedProgressEmpty('No device is selected. Choose a device row to view full readiness details.');
      clearProgressContext('No selected device available for lifecycle action.');
      return;
    }

    const baseSummary = activitySummaryByDeviceUid[candidate.device_uid] || {};
    let evidence = {
      syncRow: baseSummary.latestSync || null,
      latestBatch: baseSummary.latestBatch || null,
      successfulBatch: baseSummary.latestSuccessfulBatch || null,
      latestCommand: baseSummary.latestPullCommand || null,
      readiness: readinessByDeviceUid[candidate.device_uid] || null,
      agentRow: (readinessByDeviceUid[candidate.device_uid] && readinessByDeviceUid[candidate.device_uid].managing_agent) || null,
      recentEvents: []
    };
    let note = 'Selected device details combine live actionability, historical proof, and recent data evidence. SaaS queues actions; the Local Agent talks to the device.';
    try {
      evidence = await loadValidatedProgressEvidence(cfg.companyId, candidate.device_uid);
      if (evidence && evidence.readiness && evidence.readiness.suggested_agent_id) {
        setOnboardingAgentInputValue(evidence.readiness.suggested_agent_id, { force: false });
      }
    } catch (err) {
      note = 'Selected device loaded; detailed evidence refresh is partial: ' + (err && err.message ? err.message : 'unknown error');
    }

    const actionContext = actionContextByDeviceUid[candidate.device_uid]
      || deriveProgressActionContext(candidate, evidence, cfg.companyId);
    renderValidatedProgress(candidate, evidence, actionContext, note);

    state.progressContext = actionContext;
    setQueuePullButtonState(state.progressContext);
    setQueuePullFeedback(
      actionContext.feedbackKind || 'warn',
      actionContext.reason || 'Action availability is currently unknown.'
    );
  }

  function getApiErrorCode(err) {
    const details = err && err.body && err.body.details;
    if (details && typeof details.error === 'string') {
      return details.error.trim().toLowerCase();
    }
    return '';
  }

  function describeActionFailure(actionType, err) {
    const details = err && err.body && err.body.details ? err.body.details : {};
    const code = getApiErrorCode(err);
    const fallback = err && err.message ? err.message : 'unknown error';

    if (actionType === 'validate_candidate') {
      if (code === 'insufficient_role') {
        return 'Validation unavailable for current API key role. Operator or admin access is required.';
      }
      if (code === 'agent_not_found') {
        return 'Validation unavailable: selected agent was not found.';
      }
      if (code === 'agent_not_active') {
        return 'Validation unavailable: selected agent is not active.';
      }
      if (code === 'device_not_found') {
        return 'Validation unavailable: candidate device was not found.';
      }
      if (code === 'device_not_candidate') {
        return 'Validation unavailable: device is no longer in candidate status.';
      }
      if (code === 'device_missing_required_connection_fields') {
        return 'Validation unavailable: required connection metadata is incomplete.';
      }
      return 'Validation failed: ' + fallback;
    }

    if (actionType === 'claim_candidate') {
      if (code === 'insufficient_role') {
        return 'Claim unavailable for current API key role. Operator or admin access is required.';
      }
      if (code === 'candidate_device_not_found') {
        return 'Candidate was not found. Refresh device state; it may already be claimed or no longer candidate.';
      }
      return 'Claim failed: ' + fallback;
    }

    if (actionType === 'queue_pull') {
      if (code === 'insufficient_role') {
        return 'Queue unavailable for current API key role. Admin access is required for command queueing.';
      }
      if (code === 'device_managing_agent_binding_missing') {
        return 'Queue unavailable: no active managing-agent binding exists for this managed device.';
      }
      if (code === 'device_managing_agent_binding_conflict') {
        const boundAgentId = firstNonEmpty([details && details.bound_agent_id]);
        if (boundAgentId) {
          return 'Queue unavailable: device is actively bound to another agent (' + boundAgentId + ').';
        }
        return 'Queue unavailable: device is actively bound to another agent.';
      }
      if (code === 'device_not_managed') {
        return 'Queue unavailable: device is not in managed status.';
      }
      if (code === 'agent_not_active') {
        return 'Queue unavailable: selected managing agent is not active.';
      }
      if (code === 'agent_not_found') {
        return 'Queue unavailable: managing agent was not found.';
      }
      if (code === 'device_uid_superseded_without_canonical') {
        return 'Queue unavailable: device UID is superseded without canonical resolution.';
      }
      return 'Queue failed: ' + fallback;
    }

    if (actionType === 'bind_managing_agent') {
      if (code === 'insufficient_role') {
        return 'Binding unavailable for current API key role. Operator or admin access is required.';
      }
      if (code === 'agent_not_found') {
        return 'Binding unavailable: selected agent was not found.';
      }
      if (code === 'agent_not_active') {
        return 'Binding unavailable: selected agent is not active.';
      }
      if (code === 'device_not_managed') {
        return 'Binding unavailable: device is not in managed status.';
      }
      if (code === 'device_not_found') {
        return 'Binding unavailable: device was not found.';
      }
      if (code === 'device_uid_superseded_without_canonical') {
        return 'Binding unavailable: device UID is superseded without canonical resolution.';
      }
      return 'Binding failed: ' + fallback;
    }

    return fallback;
  }

  async function queuePullNow() {
    const context = state.progressContext;
    if (!context || !context.actionType || context.actionType === 'none') {
      setQueuePullFeedback('warn', 'No operational action is available for the selected device.');
      return;
    }
    if (!context.actionEligible) {
      setQueuePullFeedback('warn', context.reason || 'Action is currently unavailable.');
      return;
    }
    if (!context.companyId || !context.deviceUid) {
      setQueuePullFeedback('warn', 'Action context is incomplete. Refresh device evidence.');
      return;
    }

    state.queuePullInFlight = true;
    setQueuePullButtonState(context);
    if (context.actionType === 'validate_candidate') {
      setQueuePullFeedback('warn', 'Queueing validation command...');
    } else if (context.actionType === 'claim_candidate') {
      setQueuePullFeedback('warn', 'Claiming device...');
    } else if (context.actionType === 'bind_managing_agent') {
      setQueuePullFeedback('warn', 'Binding managing agent...');
    } else {
      setQueuePullFeedback('warn', 'Queueing pull request. The Local Agent will contact the device.');
    }

    try {
      if (context.actionType === 'validate_candidate') {
        await apiPost('/api/agent-admin/devices/' + encodeURIComponent(context.deviceUid) + '/validate', {
          company_id: context.companyId,
          agent_id: context.agentId
        });
        setQueuePullFeedback('ok', 'Validation queued. Refreshing status...');
        await refreshAll();
        setQueuePullFeedback('ok', 'Validation queued and status refreshed.');
      } else if (context.actionType === 'claim_candidate') {
        await apiPost('/api/agent-admin/discovered-devices/' + encodeURIComponent(context.deviceUid) + '/claim', {
          company_id: context.companyId
        });
        setQueuePullFeedback('ok', 'Device claimed. Refreshing status...');
        await refreshAll();
        setQueuePullFeedback('ok', 'Device claimed and status refreshed.');
      } else if (context.actionType === 'bind_managing_agent') {
        await apiPut('/api/agent-admin/devices/' + encodeURIComponent(context.deviceUid) + '/managing-agent-binding', {
          company_id: context.companyId,
          agent_id: context.agentId
        });
        setQueuePullFeedback('ok', 'Managing agent bound. Refreshing status...');
        await refreshAll();
        setQueuePullFeedback('ok', 'Managing agent binding saved and status refreshed.');
      } else if (context.actionType === 'queue_pull') {
        await apiPost('/api/agent-admin/agents/' + encodeURIComponent(context.agentId) + '/commands/pull-device-events', {
          company_id: context.companyId,
          device_uid: context.deviceUid
        });
        setQueuePullFeedback('ok', 'Pull request queued. Refreshing status...');
        await refreshAll();
        setQueuePullFeedback('ok', 'Pull request queued and status refreshed.');
      } else {
        setQueuePullFeedback('warn', 'Unsupported action type for selected context.');
      }
    } catch (err) {
      const message = describeActionFailure(context.actionType, err);
      setQueuePullFeedback('err', message);
      setGlobalStatus('err', message);
    } finally {
      state.queuePullInFlight = false;
      setQueuePullButtonState(state.progressContext);
    }
  }

  function commandTypeLabel(type) {
    const value = String(type || '').toUpperCase();
    if (value === 'PULL_DEVICE_EVENTS') return 'Pull device events';
    if (value === 'VALIDATE_DEVICE_CANDIDATE') return 'Validate candidate device';
    if (value === 'SCAN_SUBNET') return 'Scan subnet';
    if (value === 'START_DEVICE_MONITORING') return 'Start device monitoring';
    if (value === 'STOP_DEVICE_MONITORING') return 'Stop device monitoring';
    return type || '-';
  }

  async function loadCommands() {
    const cfg = getConfig();
    const data = await apiGet('/api/agent-admin/commands', {
      company_id: cfg.companyId,
      agent_id: byId('commandsAgentId').value,
      device_uid: byId('commandsDeviceUid').value,
      status: byId('commandsStatus').value,
      created_from: byId('commandsCreatedFrom').value,
      created_to: byId('commandsCreatedTo').value,
      limit: byId('commandsLimit').value
    });
    const rows = extractRows(data);
    const body = byId('commandsBody');
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="8" class="empty">No rows.</td></tr>';
      return;
    }

    body.innerHTML = rows.map(row => {
      const deviceUid = row && row.command_payload && row.command_payload.device_uid
        ? row.command_payload.device_uid
        : '-';
      return (
        '<tr>' +
          '<td><span class="' + badgeClass(classifyCommandStatus(row.status)) + '">' + escapeHtml(row.status || '-') + '</span></td>' +
          '<td>' + escapeHtml(commandTypeLabel(row.command_type)) + '</td>' +
          '<td>' + escapeHtml(deviceUid) + '</td>' +
          '<td>' + escapeHtml(row.agent_id || '-') + '</td>' +
          '<td>' + escapeHtml(row.failure_reason || '-') + '</td>' +
          '<td>' + escapeHtml(formatDateTime(row.sent_at)) + '</td>' +
          '<td>' + escapeHtml(formatDateTime(row.acknowledged_at)) + '</td>' +
          '<td>' + escapeHtml(formatDateTime(row.created_at)) + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  function freshnessLabel(row) {
    const minutes = minutesSince(row && row.last_sync_completed_at);
    if (minutes === null) {
      return { text: 'No completion yet', kind: 'warn' };
    }
    if (minutes > 120) {
      return { text: 'Stale (' + minutes + 'm)', kind: 'danger' };
    }
    if (minutes > 30) {
      return { text: 'Aging (' + minutes + 'm)', kind: 'warn' };
    }
    return { text: 'Fresh (' + minutes + 'm)', kind: 'ok' };
  }

  async function loadSyncStates() {
    const cfg = getConfig();
    const data = await apiGet('/api/agent-admin/device-sync-states', {
      company_id: cfg.companyId,
      agent_id: byId('syncAgentId').value,
      device_uid: byId('syncDeviceUid').value,
      limit: byId('syncLimit').value
    });
    const rows = extractRows(data);
    const body = byId('syncBody');
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="7" class="empty">No rows.</td></tr>';
      return;
    }

    body.innerHTML = rows.map(row => {
      const fresh = freshnessLabel(row);
      return (
        '<tr>' +
          '<td>' + escapeHtml(row.device_uid || '-') + '</td>' +
          '<td>' + escapeHtml(row.agent_id || '-') + '</td>' +
          '<td><span class="' + badgeClass(classifySyncStatus(row.status)) + '">' + escapeHtml(row.status || '-') + '</span></td>' +
          '<td>' + escapeHtml(row.cursor_event_time_utc || '-') + '</td>' +
          '<td>' + escapeHtml(formatDateTime(row.last_sync_completed_at)) + '</td>' +
          '<td>' + escapeHtml(row.failure_reason || '-') + '</td>' +
          '<td><span class="' + badgeClass(fresh.kind) + '">' + escapeHtml(fresh.text) + '</span></td>' +
        '</tr>'
      );
    }).join('');
  }

  async function loadBatches() {
    const cfg = getConfig();
    const data = await apiGet('/api/agent-admin/device-event-batches', {
      company_id: cfg.companyId,
      agent_id: byId('batchesAgentId').value,
      device_uid: byId('batchesDeviceUid').value,
      status: byId('batchesStatus').value,
      created_from: byId('batchesCreatedFrom').value,
      created_to: byId('batchesCreatedTo').value,
      limit: byId('batchesLimit').value
    });
    const rows = extractRows(data);
    const body = byId('batchesBody');
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="8" class="empty">No rows.</td></tr>';
      return;
    }

    body.innerHTML = rows.map(row => (
      '<tr>' +
        '<td><span class="' + badgeClass(classifyBatchStatus(row.status)) + '">' + escapeHtml(row.status || '-') + '</span></td>' +
        '<td>' + escapeHtml(row.device_uid || '-') + '</td>' +
        '<td>' + escapeHtml(row.failure_reason || '-') + '</td>' +
        '<td>' + escapeHtml(row.inserted_count === undefined ? '-' : row.inserted_count) + '</td>' +
        '<td>' + escapeHtml(row.deduped_count === undefined ? '-' : row.deduped_count) + '</td>' +
        '<td>' + escapeHtml(row.rejected_count === undefined ? '-' : row.rejected_count) + '</td>' +
        '<td>' + escapeHtml(formatDateTime(row.pull_completed_at)) + '</td>' +
        '<td><pre class="samples">' + escapeHtml(formatSamples(row.rejection_samples)) + '</pre></td>' +
      '</tr>'
    )).join('');
  }

  function selectedOpsDevice() {
    const uid = String(state.opsSelectedDeviceUid || '').trim();
    if (!uid) {
      return null;
    }
    return state.opsDevices.find(row => String(row && row.device_uid || '') === uid) || null;
  }

  function updateOpsMonitoringStatus(kind, text) {
    const el = byId('opsMonitoringStatus');
    if (!el) {
      return;
    }
    el.className = 'status card';
    if (kind === 'ok') {
      el.classList.add('status-ok');
    } else if (kind === 'warn') {
      el.classList.add('status-warn');
    } else if (kind === 'err') {
      el.classList.add('status-err');
    } else {
      el.classList.add('status-info');
    }
    el.textContent = text;
  }

  function updateOpsSseStatus(kind, text) {
    const el = byId('opsSseStatus');
    if (!el) {
      return;
    }
    el.className = 'status card';
    if (kind === 'ok') {
      el.classList.add('status-ok');
    } else if (kind === 'warn') {
      el.classList.add('status-warn');
    } else if (kind === 'err') {
      el.classList.add('status-err');
    } else {
      el.classList.add('status-info');
    }
    el.textContent = text;
  }

  function opsConnectionSummary(row) {
    const metadata = parseObject(row && row.metadata);
    const manual = parseObject(metadata.manual_onboarding);
    const manualConnection = parseObject(manual.connection);
    const connection = parseObject(metadata.connection);
    const discovery = parseObject(row && row.discovery_metadata);
    return {
      host: firstNonEmpty([manualConnection.host, connection.host, metadata.host, metadata.ip, discovery.host, discovery.ip]),
      port: firstNonEmpty([manualConnection.port, connection.port, metadata.port, discovery.port]) || '4370',
      transport: firstNonEmpty([manualConnection.transport, connection.transport, metadata.transport, discovery.transport]) || 'tcp',
      deviceNumber: firstNonEmpty([manualConnection.device_number, connection.device_number, metadata.device_number]) || '1',
      authPresent: Boolean(firstNonEmpty([
        manualConnection.auth_password,
        manualConnection.communication_key,
        manualConnection.comm_key,
        connection.auth_password,
        metadata.auth_password,
        metadata.communication_key,
        metadata.comm_key
      ]))
    };
  }

  function opsDeviceAgentId(row) {
    const uid = row && row.device_uid ? String(row.device_uid) : '';
    const readiness = uid ? state.opsReadinessByDeviceUid[uid] : null;
    const summary = uid ? state.opsActivityByDeviceUid[uid] : null;
    return firstNonEmpty([
      readiness && readiness.active_binding && readiness.active_binding.agent_id,
      readiness && readiness.managing_agent && readiness.managing_agent.id,
      row && row.last_agent_id,
      row && row.discovered_by_agent_id,
      summary && summary.latestPullCommand && summary.latestPullCommand.agent_id
    ]);
  }

  function renderOpsCompanies(rows) {
    const body = byId('opsCompaniesBody');
    if (!body) {
      return;
    }
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">No companies found.</td></tr>';
      return;
    }
    const cfg = getConfig();
    body.innerHTML = rows.map(row => {
      const companyId = row.company_id || '';
      const selected = companyId === cfg.companyId;
      return (
        '<tr>' +
          '<td><button type="button" class="ops-company-select" data-company-id="' + escapeHtml(companyId) + '">' + escapeHtml(selected ? 'Active' : 'Use') + '</button></td>' +
          '<td><div class="device-cell-title">' + escapeHtml(row.display_name || companyId || '-') + '</div><div class="device-cell-sub">' + escapeHtml(companyId || '-') + '</div></td>' +
          '<td>' + escapeHtml(row.timezone || '-') + '</td>' +
          '<td><span class="' + badgeClass(row.is_active === false ? 'warn' : 'ok') + '">' + escapeHtml(row.is_active === false ? 'inactive' : 'active') + '</span></td>' +
          '<td>' + escapeHtml(formatDateTime(row.updated_at)) + '</td>' +
        '</tr>'
      );
    }).join('');
    body.querySelectorAll('.ops-company-select').forEach(button => {
      button.addEventListener('click', () => {
        byId('companyId').value = String(button.getAttribute('data-company-id') || '').trim() || 'DEFAULT';
        persistConfig();
        refreshAll().catch(err => setGlobalStatus('err', 'Company switch refresh failed: ' + err.message));
      });
    });
  }

  async function loadOpsCompanies() {
    const payload = await apiGet('/api/companies', {
      include_inactive: true,
      limit: 200
    });
    renderOpsCompanies(extractRows(payload));
  }

  async function addOpsCompany() {
    const companyId = String(byId('opsCompanyNewId').value || '').trim();
    const displayName = String(byId('opsCompanyNewName').value || '').trim();
    const timezone = String(byId('opsCompanyNewTimezone').value || '').trim();
    if (!companyId || !displayName) {
      setGlobalStatus('warn', 'Company ID and display name are required.');
      return;
    }
    await apiPost('/api/companies', {
      company_id: companyId,
      display_name: displayName,
      timezone: timezone || null,
      is_active: true
    });
    byId('companyId').value = companyId;
    persistConfig();
    await loadOpsCompanies();
    setGlobalStatus('ok', 'Company added and selected: ' + companyId);
  }

  function renderOpsDevices() {
    const body = byId('opsDevicesBody');
    if (!body) {
      return;
    }
    if (!state.opsDevices.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty">No devices found.</td></tr>';
      renderOpsDeviceDetail();
      return;
    }
    body.innerHTML = state.opsDevices.map(row => {
      const uid = row.device_uid || '';
      const facts = extractDeviceFacts(row);
      const summary = state.opsActivityByDeviceUid[uid] || {};
      const latestCommand = summary.latestPullCommand || null;
      const latestBatch = summary.latestBatch || null;
      const selected = uid && uid === state.opsSelectedDeviceUid;
      return (
        '<tr>' +
          '<td><button type="button" class="ops-device-select" data-device-uid="' + escapeHtml(uid) + '">' + escapeHtml(selected ? 'Selected' : 'Open') + '</button></td>' +
          '<td><div class="device-cell-title">' + escapeHtml(facts.label || uid || '-') + '</div><div class="device-cell-sub">' + escapeHtml(uid || '-') + '</div></td>' +
          '<td><div class="device-cell-title">' + escapeHtml(firstNonEmpty([facts.vendor, row.provider]) || '-') + '</div><div class="device-cell-sub">' + escapeHtml(firstNonEmpty([facts.model, facts.firmware]) || '-') + '</div></td>' +
          '<td><span class="' + badgeClass(row.managed_status === 'managed' ? 'ok' : 'warn') + '">' + escapeHtml(row.managed_status || '-') + '</span></td>' +
          '<td>' + escapeHtml(opsDeviceAgentId(row) || 'not bound') + '</td>' +
          '<td>' + escapeHtml(latestCommand ? ((latestCommand.command_type || '-') + ' / ' + (latestCommand.status || '-')) : '-') + '</td>' +
          '<td>' + escapeHtml(latestBatch ? ((latestBatch.status || '-') + ' inserted=' + toCount(latestBatch.inserted_count) + ' deduped=' + toCount(latestBatch.deduped_count)) : '-') + '</td>' +
        '</tr>'
      );
    }).join('');
    body.querySelectorAll('.ops-device-select').forEach(button => {
      button.addEventListener('click', () => {
        state.opsSelectedDeviceUid = String(button.getAttribute('data-device-uid') || '').trim();
        state.opsRealtimeRows = [];
        state.opsRealtimeProofReceived = false;
        closeOpsRealtimeStream();
        renderOpsDevices();
        renderOpsDeviceDetail();
        loadOpsRealtimeRows().catch(err => updateOpsSseStatus('err', 'Manual RT refresh failed: ' + err.message));
        openOpsRealtimeStream();
      });
    });
  }

  async function loadOpsDevices() {
    const cfg = getConfig();
    const payload = await apiGet('/api/devices', {
      company_id: cfg.companyId,
      device_uid: byId('opsDeviceUidFilter').value,
      lifecycle_scope: 'bridge_ops',
      limit: byId('opsDevicesLimit').value
    });
    state.opsDevices = extractRows(payload);
    const [readinessResult, activityResult] = await Promise.allSettled([
      loadDevicesReadinessMap(cfg.companyId, state.opsDevices),
      loadDeviceActivitySummaryMap(cfg.companyId)
    ]);
    state.opsReadinessByDeviceUid = readinessResult.status === 'fulfilled' ? (readinessResult.value || {}) : {};
    state.opsActivityByDeviceUid = activityResult.status === 'fulfilled' ? (activityResult.value || {}) : {};
    if (!state.opsSelectedDeviceUid && state.opsDevices[0] && state.opsDevices[0].device_uid) {
      state.opsSelectedDeviceUid = state.opsDevices[0].device_uid;
    }
    if (state.opsSelectedDeviceUid && !state.opsDevices.some(row => row.device_uid === state.opsSelectedDeviceUid)) {
      state.opsSelectedDeviceUid = state.opsDevices[0] && state.opsDevices[0].device_uid ? state.opsDevices[0].device_uid : '';
    }
    renderOpsDevices();
    renderOpsDeviceDetail();
    if (state.opsSelectedDeviceUid) {
      await loadOpsRealtimeRows();
      openOpsRealtimeStream();
    }
  }

  function renderOpsDeviceDetail() {
    const el = byId('opsDeviceDetail');
    if (!el) {
      return;
    }
    const row = selectedOpsDevice();
    if (!row) {
      el.innerHTML = '<p class="empty">Select a device to view detail.</p>';
      updateOpsMonitoringStatus('info', 'Monitoring session not started in this tab.');
      return;
    }
    const uid = row.device_uid || '';
    const facts = extractDeviceFacts(row);
    const connection = opsConnectionSummary(row);
    const readiness = state.opsReadinessByDeviceUid[uid] || null;
    const summary = state.opsActivityByDeviceUid[uid] || {};
    const session = state.opsMonitoringSession && state.opsMonitoringSession.device_uid === uid
      ? state.opsMonitoringSession
      : null;
    const latestCommand = summary.latestPullCommand || null;
    const latestBatch = summary.latestBatch || null;
    const latestSync = summary.latestSync || null;
    const monitoringState = session
      ? (session.status || 'unknown') + ' / session ' + session.id
      : 'not started in this tab';
    el.innerHTML = (
      '<div class="panel-grid">' +
        '<div>' +
          '<h4>Identity</h4>' +
          kv('device_uid', uid) +
          kv('label', facts.label || '-') +
          kv('provider', firstNonEmpty([facts.vendor, row.provider]) || '-') +
          kv('model', firstNonEmpty([facts.model, facts.firmware]) || '-') +
          kv('managed_status', row.managed_status || '-') +
        '</div>' +
        '<div>' +
          '<h4>Connection</h4>' +
          kv('host', connection.host || '-') +
          kv('port', connection.port || '-') +
          kv('transport', connection.transport || '-') +
          kv('device_number', connection.deviceNumber || '-') +
          kv('auth', connection.authPresent ? 'present' : 'not present in metadata') +
        '</div>' +
        '<div>' +
          '<h4>Agent / Monitoring</h4>' +
          kv('managing_agent', opsDeviceAgentId(row) || '-') +
          kv('readiness', readiness ? (readiness.readiness_status || '-') : '-') +
          kv('monitoring', monitoringState) +
          kv('start_command_id', session && session.start_command_id ? session.start_command_id : '-') +
          kv('stop_command_id', session && session.stop_command_id ? session.stop_command_id : '-') +
        '</div>' +
        '<div>' +
          '<h4>Latest Sync / Batch</h4>' +
          kv('latest_command', latestCommand ? ((latestCommand.command_type || '-') + ' / ' + (latestCommand.status || '-')) : '-') +
          kv('latest_batch', latestBatch ? ((latestBatch.status || '-') + ' inserted=' + toCount(latestBatch.inserted_count) + ' deduped=' + toCount(latestBatch.deduped_count)) : '-') +
          kv('latest_sync', latestSync ? ((latestSync.status || '-') + ' / ' + formatDateTime(latestSync.last_sync_completed_at)) : '-') +
        '</div>' +
      '</div>'
    );
    if (session) {
      const sessionStatus = String(session.status || 'unknown').toLowerCase();
      if (sessionStatus === 'stopped' || sessionStatus === 'expired') {
        updateOpsMonitoringStatus('ok', 'Monitoring session ' + sessionStatus + '.');
      } else if (sessionStatus === 'failed') {
        updateOpsMonitoringStatus('err', 'Monitoring session failed.');
      } else {
        const pendingProof = !state.opsRealtimeProofReceived;
        updateOpsMonitoringStatus(
          pendingProof ? 'warn' : 'ok',
          pendingProof
            ? 'Monitoring session ' + (session.status || 'unknown') + '. Pending live RT observation proof through this flow.'
            : 'Monitoring session has received at least one RT observation in this browser flow.'
        );
      }
    }
  }

  async function connectOpsMonitoring() {
    const row = selectedOpsDevice();
    if (!row || !row.device_uid) {
      updateOpsMonitoringStatus('warn', 'Select a device before connecting monitoring.');
      return;
    }
    updateOpsMonitoringStatus('warn', 'Creating monitoring session and queueing START_DEVICE_MONITORING...');
    const cfg = getConfig();
    const session = await apiPost('/api/agent-admin/devices/' + encodeURIComponent(row.device_uid) + '/monitoring-sessions', {
      company_id: cfg.companyId,
      rt_enabled: true,
      lease_ttl_seconds: 300
    });
    state.opsMonitoringSession = session;
    state.opsRealtimeProofReceived = false;
    renderOpsDeviceDetail();
    updateOpsMonitoringStatus('warn', 'Session ' + session.id + ' created; start command ' + (session.start_command_id || '-') + ' queued. Waiting for active status.');
    await pollOpsMonitoringSession(['active', 'failed'], 10, 1500);
    openOpsRealtimeStream();
  }

  async function refreshOpsMonitoringSession() {
    if (!state.opsMonitoringSession || !state.opsMonitoringSession.id) {
      return null;
    }
    const cfg = getConfig();
    const session = await apiGet('/api/agent-admin/device-monitoring-sessions/' + encodeURIComponent(state.opsMonitoringSession.id), {
      company_id: cfg.companyId
    });
    state.opsMonitoringSession = session;
    renderOpsDeviceDetail();
    return session;
  }

  async function pollOpsMonitoringSession(doneStatuses, attempts, delayMs) {
    const targets = new Set((doneStatuses || []).map(value => String(value || '').toLowerCase()));
    let latest = null;
    for (let i = 0; i < attempts; i += 1) {
      latest = await refreshOpsMonitoringSession();
      const status = String(latest && latest.status || '').toLowerCase();
      if (targets.has(status)) {
        return latest;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    return latest;
  }

  async function disconnectOpsMonitoring() {
    if (!state.opsMonitoringSession || !state.opsMonitoringSession.id) {
      updateOpsMonitoringStatus('warn', 'No monitoring session is tracked in this tab.');
      return;
    }
    const cfg = getConfig();
    updateOpsMonitoringStatus('warn', 'Queueing STOP_DEVICE_MONITORING...');
    const session = await apiDelete('/api/agent-admin/device-monitoring-sessions/' + encodeURIComponent(state.opsMonitoringSession.id), {
      company_id: cfg.companyId,
      stop_reason: 'operator_stop'
    });
    state.opsMonitoringSession = session;
    closeOpsRealtimeStream();
    renderOpsDeviceDetail();
    updateOpsMonitoringStatus('warn', 'Stop command ' + (session.stop_command_id || '-') + ' queued; session status is ' + (session.status || 'unknown') + '.');
    await pollOpsMonitoringSession(['stopped', 'failed', 'expired'], 10, 1500);
  }

  async function syncOpsHistory() {
    const row = selectedOpsDevice();
    if (!row || !row.device_uid) {
      updateOpsMonitoringStatus('warn', 'Select a device before syncing full history.');
      return;
    }
    const agentId = opsDeviceAgentId(row);
    if (!agentId) {
      updateOpsMonitoringStatus('warn', 'Cannot sync full history: managing agent is unknown.');
      return;
    }
    const cfg = getConfig();
    updateOpsMonitoringStatus('warn', 'Queueing full-history sync command...');
    const result = await apiPost('/api/agent-admin/agents/' + encodeURIComponent(agentId) + '/commands/pull-device-events', {
      company_id: cfg.companyId,
      device_uid: row.device_uid,
      options: {
        history_mode: 'history_drain',
        device_timezone: 'Africa/Tunis',
        max_events: 500
      }
    });
    updateOpsMonitoringStatus('ok', 'Full-history sync queued: ' + (result.id || result.command_id || 'command created') + '.');
    await loadOpsDevices();
  }

  function normalizeRtRows(payload) {
    const rows = extractRows(payload);
    return rows.slice().sort((a, b) => {
      const at = new Date(a.created_at || 0).getTime();
      const bt = new Date(b.created_at || 0).getTime();
      if (at !== bt) {
        return at - bt;
      }
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
  }

  function mergeOpsRealtimeRow(row) {
    if (!row || !row.id) {
      return;
    }
    const exists = state.opsRealtimeRows.some(item => item.id === row.id);
    if (!exists) {
      state.opsRealtimeRows.push(row);
      state.opsRealtimeRows.sort((a, b) => {
        const at = new Date(a.created_at || 0).getTime();
        const bt = new Date(b.created_at || 0).getTime();
        if (at !== bt) {
          return at - bt;
        }
        return String(a.id || '').localeCompare(String(b.id || ''));
      });
    }
    if (state.opsMonitoringSession && row.created_at) {
      const created = new Date(row.created_at).getTime();
      const sessionStarted = new Date(state.opsMonitoringSession.started_at || state.opsMonitoringSession.created_at || 0).getTime();
      if (!Number.isNaN(created) && !Number.isNaN(sessionStarted) && created >= sessionStarted) {
        state.opsRealtimeProofReceived = true;
      }
    }
  }

  function renderOpsRealtimeRows() {
    const body = byId('opsRealtimeBody');
    if (!body) {
      return;
    }
    if (!state.opsRealtimeRows.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty">No realtime observations loaded.</td></tr>';
      return;
    }
    body.innerHTML = state.opsRealtimeRows.slice(-100).reverse().map(row => {
      const meta = parseObject(row.source_metadata);
      const dual = [
        'contract=' + firstNonEmpty([meta.rt_time_contract_version]),
        'trust=' + firstNonEmpty([meta.rt_time_observed_trust]),
        'chronology=' + firstNonEmpty([meta.rt_time_chronology_source])
      ].join(' ');
      return (
        '<tr>' +
          '<td>' + escapeHtml(formatDateTime(row.created_at)) + '</td>' +
          '<td>' + escapeHtml(firstNonEmpty([row.person_id, row.device_person_id]) || '-') + '</td>' +
          '<td>' + escapeHtml(row.rt_state_code || '-') + '</td>' +
          '<td><span class="' + badgeClass(row.direction_provisional === 'IN' || row.direction_provisional === 'OUT' ? 'ok' : 'warn') + '">' + escapeHtml(row.direction_provisional || '-') + '</span></td>' +
          '<td>' + escapeHtml(row.batch_id || '-') + '</td>' +
          '<td>' + escapeHtml(dual) + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  async function loadOpsRealtimeRows() {
    const row = selectedOpsDevice();
    if (!row || !row.device_uid) {
      return;
    }
    const cfg = getConfig();
    const payload = await apiGet('/api/agent-admin/devices/' + encodeURIComponent(row.device_uid) + '/realtime-observations', {
      company_id: cfg.companyId,
      limit: 50
    });
    const loadedRows = normalizeRtRows(payload);
    state.opsRealtimeRows = [];
    loadedRows.forEach(mergeOpsRealtimeRow);
    renderOpsRealtimeRows();
    renderOpsDeviceDetail();
  }

  function closeOpsRealtimeStream() {
    if (state.opsRealtimeSource) {
      state.opsRealtimeSource.close();
      state.opsRealtimeSource = null;
      updateOpsSseStatus('warn', 'SSE disconnected.');
    }
  }

  function openOpsRealtimeStream() {
    const row = selectedOpsDevice();
    if (!row || !row.device_uid || typeof EventSource !== 'function') {
      updateOpsSseStatus('warn', 'SSE unavailable; use manual RT refresh.');
      return;
    }
    closeOpsRealtimeStream();
    const cfg = getConfig();
    if (cfg.apiKey) {
      updateOpsSseStatus('warn', 'SSE cannot send x-api-key headers from EventSource. Use manual refresh when auth is required.');
      return;
    }
    const last = state.opsRealtimeRows[state.opsRealtimeRows.length - 1] || null;
    const query = {
      company_id: cfg.companyId
    };
    if (last && last.created_at) {
      query.after_created_at = last.created_at;
      query.after_id = last.id;
    }
    const source = new EventSource(buildUrl('/api/agent-admin/devices/' + encodeURIComponent(row.device_uid) + '/realtime-observations/stream', query));
    state.opsRealtimeSource = source;
    updateOpsSseStatus('warn', 'SSE connecting for realtime observations...');
    source.addEventListener('ready', () => {
      updateOpsSseStatus('ok', 'SSE connected. Waiting for realtime observations.');
    });
    source.addEventListener('rt_observation', event => {
      try {
        const row = JSON.parse(event.data);
        mergeOpsRealtimeRow(row);
        renderOpsRealtimeRows();
        renderOpsDeviceDetail();
        updateOpsSseStatus('ok', 'Realtime observation received at ' + new Date().toLocaleString() + '.');
      } catch (err) {
        updateOpsSseStatus('err', 'SSE row parse failed: ' + (err && err.message ? err.message : 'unknown error'));
      }
    });
    source.addEventListener('error', () => {
      updateOpsSseStatus('err', 'SSE disconnected or failed. Use manual RT refresh.');
    });
  }

  async function loadOperationsPanel() {
    await Promise.allSettled([
      loadOpsCompanies(),
      loadOpsDevices()
    ]);
  }

  function setTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.tab').forEach(btn => {
      const isActive = btn.getAttribute('data-tab') === tabName;
      btn.classList.toggle('tab-active', isActive);
    });
    document.querySelectorAll('.panel').forEach(panel => {
      const panelName = panel.id.replace('panel-', '');
      panel.classList.toggle('panel-active', panelName === tabName);
    });
  }

  async function refreshAll() {
    persistConfig();
    const cfg = getConfig();
    setGlobalStatus('info', 'Refreshing operational data for ' + cfg.companyId + ' (' + cfg.environment + ')...');

    const tasks = [
      loadOverview(),
      loadAgents(),
      loadDevices(),
      loadOperationsPanel(),
      loadCommands(),
      loadSyncStates(),
      loadBatches()
    ];

    const results = await Promise.allSettled(tasks);
    const failures = results.filter(item => item.status === 'rejected');
    if (failures.length > 0) {
      const first = failures[0].reason;
      setGlobalStatus('err', 'Refresh completed with errors: ' + (first && first.message ? first.message : 'unknown error'));
    } else {
      setGlobalStatus('ok', 'Last refreshed at ' + new Date().toLocaleString());
    }
  }

  function bindEvents() {
    byId('btnRefresh').addEventListener('click', function () {
      refreshAll();
    });

    byId('btnLoadAgents').addEventListener('click', function () {
      loadAgents().catch(err => setGlobalStatus('err', 'Agents load failed: ' + err.message));
    });

    byId('btnLoadDevices').addEventListener('click', function () {
      loadDevices().catch(err => setGlobalStatus('err', 'Devices load failed: ' + err.message));
    });

    byId('btnOpsLoadCompanies').addEventListener('click', function () {
      loadOpsCompanies().catch(err => setGlobalStatus('err', 'Companies load failed: ' + err.message));
    });

    byId('btnOpsAddCompany').addEventListener('click', function () {
      addOpsCompany().catch(err => setGlobalStatus('err', 'Company add failed: ' + err.message));
    });

    byId('btnOpsLoadDevices').addEventListener('click', function () {
      loadOpsDevices().catch(err => setGlobalStatus('err', 'Operations devices load failed: ' + err.message));
    });

    byId('btnOpsConnectMonitoring').addEventListener('click', function () {
      connectOpsMonitoring().catch(err => {
        updateOpsMonitoringStatus('err', 'Connect monitoring failed: ' + err.message);
        setGlobalStatus('err', 'Connect monitoring failed: ' + err.message);
      });
    });

    byId('btnOpsDisconnectMonitoring').addEventListener('click', function () {
      disconnectOpsMonitoring().catch(err => {
        updateOpsMonitoringStatus('err', 'Disconnect monitoring failed: ' + err.message);
        setGlobalStatus('err', 'Disconnect monitoring failed: ' + err.message);
      });
    });

    byId('btnOpsSyncHistory').addEventListener('click', function () {
      syncOpsHistory().catch(err => {
        updateOpsMonitoringStatus('err', 'Full-history sync failed: ' + err.message);
        setGlobalStatus('err', 'Full-history sync failed: ' + err.message);
      });
    });

    byId('btnOpsRefreshRealtime').addEventListener('click', function () {
      loadOpsRealtimeRows()
        .then(() => updateOpsSseStatus('ok', 'Realtime observations refreshed manually.'))
        .catch(err => updateOpsSseStatus('err', 'Manual RT refresh failed: ' + err.message));
    });

    byId('btnQueuePullNow').addEventListener('click', function () {
      queuePullNow().catch(err => {
        setQueuePullFeedback('err', 'Action failed: ' + (err && err.message ? err.message : 'unknown error'));
        setGlobalStatus('err', 'Device action failed: ' + (err && err.message ? err.message : 'unknown error'));
      });
    });

    const onboardingAgentIdInput = byId('onboardingAgentId');
    if (onboardingAgentIdInput) {
      onboardingAgentIdInput.addEventListener('blur', function () {
        loadDevices().catch(err => setGlobalStatus('err', 'Devices load failed: ' + err.message));
      });
      onboardingAgentIdInput.addEventListener('change', function () {
        loadDevices().catch(err => setGlobalStatus('err', 'Devices load failed: ' + err.message));
      });
    }

    byId('btnLoadCommands').addEventListener('click', function () {
      loadCommands().catch(err => setGlobalStatus('err', 'Commands load failed: ' + err.message));
    });

    byId('btnLoadSync').addEventListener('click', function () {
      loadSyncStates().catch(err => setGlobalStatus('err', 'Sync state load failed: ' + err.message));
    });

    byId('btnLoadBatches').addEventListener('click', function () {
      loadBatches().catch(err => setGlobalStatus('err', 'Batches load failed: ' + err.message));
    });

    ['baseUrl', 'companyId', 'environment', 'apiKey'].forEach(id => {
      byId(id).addEventListener('blur', persistConfig);
      byId(id).addEventListener('change', persistConfig);
    });

    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', function () {
        setTab(btn.getAttribute('data-tab'));
      });
    });
  }

  function init() {
    restoreConfig();
    bindEvents();
    setQueuePullButtonState(null);
    setQueuePullFeedback('warn', 'Select a bridge device, then run the next lifecycle action (validate, claim, bind, or queue pull).');
    setTab('overview');
    refreshAll().catch(err => {
      setGlobalStatus('err', 'Initial load failed: ' + err.message);
    });
  }

  window.addEventListener('DOMContentLoaded', init);
})();

