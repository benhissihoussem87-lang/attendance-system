import { activeCompanyId, knownAgentId, state } from './state.js';
import { text } from './renderHelpers.js';

export function meta(device) {
  return device && typeof device.metadata === 'object' && device.metadata ? device.metadata : {};
}

export function connection(device) {
  const m = meta(device);
  const c = m.connection || m.network || {};
  return {
    host: device.host || c.host || c.ip || m.host || m.ip || '',
    port: Number(device.port || c.port || m.port || 4370),
    transport: device.transport || c.transport || m.transport || 'tcp',
    auth_password: c.auth_password || c.comm_key || m.auth_password || m.comm_key || undefined,
    device_number: Number(c.device_number || m.device_number || 1)
  };
}

export function provider(device) { return text(device.provider || meta(device).provider || '').trim(); }
export function model(device) { return text(device.model || meta(device).model || meta(device).device_model || '').trim(); }
export function deviceName(device) { return text(device.device_name || meta(device).label || device.device_uid); }

export function deviceSiteId(device) {
  return text(device && device.site_id).trim();
}

export function deviceSiteName(device) {
  return text(device && device.site_name).trim();
}

export function isProductReadyDevice(device) {
  const c = connection(device);
  const label = text(device.device_uid) + ' ' + deviceName(device);
  const devFixturePattern = /candidate|test|incomplete|conflict|readiness-|evt-|mon-|rt-/i;
  return device.company_id === activeCompanyId()
    && device.managed_status === 'managed'
    && Boolean(provider(device))
    && Boolean(c.host)
    && Boolean(c.port)
    && !devFixturePattern.test(label);
}

export function siteDisplayName(site) {
  return text(site && (site.site_name || site.name || site.site_key)).trim() || 'Default Site';
}

export function isProductSite(site) {
  if (!site) return false;
  const status = text(site.status).toLowerCase();
  const key = text(site.site_key).toLowerCase();
  const name = text(site.site_name).toLowerCase();
  const metadata = site.metadata && typeof site.metadata === 'object' ? site.metadata : {};
  const testLike = /contract_test|lease-site-|hq-[0-9a-f]{8}/i.test(key + ' ' + name + ' ' + text(metadata.purpose));
  return status === 'active' && !testLike;
}

export function isProductAgent(agent) {
  if (!agent) return false;
  if (agent.id === knownAgentId) return true;
  const label = text(agent.agent_name || agent.name || agent.id);
  const testLike = /contract|lease-agent|readiness-agent|monitor-agent|rt-agent|event-agent|ops-agent-[0-9a-f]{8}|test|demo/i.test(label);
  return !testLike;
}

export function siteForDevice(device) {
  const siteId = deviceSiteId(device);
  return siteId
    ? state.sites.find(site => text(site.site_id).trim() === siteId) || null
    : null;
}

function validTimeZone(value) {
  const timeZone = text(value).trim();
  if (!timeZone) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch (_) {
    return '';
  }
}

function objectTimezone(value) {
  if (!value || typeof value !== 'object') return '';
  const m = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
  return validTimeZone(
    value.timezone
      || value.device_timezone
      || value.time_zone
      || m.timezone
      || m.device_timezone
      || m.time_zone
      || (m.profile && (m.profile.timezone || m.profile.device_timezone))
  );
}

export function resolveSelectedTimezoneInfo(appState = state) {
  const selectedSite = appState.selectedDevice
    ? siteForDevice(appState.selectedDevice)
    : (appState.selectedSiteId ? appState.sites.find(site => text(site.site_id).trim() === appState.selectedSiteId) : null);
  const siteTimezone = objectTimezone(selectedSite);
  if (siteTimezone) return { timeZone: siteTimezone, source: 'selected site' };

  const deviceTimezone = objectTimezone(appState.selectedDevice);
  if (deviceTimezone) return { timeZone: deviceTimezone, source: 'selected device' };

  const companyId = activeCompanyId();
  const company = appState.companies.find(row => text(row.company_id || row.id).trim() === companyId) || null;
  const companyTimezone = objectTimezone(company);
  if (companyTimezone) return { timeZone: companyTimezone, source: 'active company' };

  const browserTimezone = validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  return { timeZone: browserTimezone || 'UTC', source: browserTimezone ? 'browser fallback' : 'UTC fallback' };
}

export function resolveSelectedTimezone(appState = state) {
  return resolveSelectedTimezoneInfo(appState).timeZone;
}

export function selectedAgentId() {
  return (state.latestCommand && state.latestCommand.agent_id)
    || (state.selectedDevice && state.selectedDevice.discovered_by_agent_id)
    || knownAgentId;
}

export function isMonitoringSessionExpired(session, now = Date.now()) {
  if (!session || !session.expires_at) return false;
  const expiresAt = new Date(session.expires_at);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now;
}

export function effectiveMonitoringStatus(session, hasRtProof = false) {
  if (!session) return 'disconnected';
  const metadata = session.metadata && typeof session.metadata === 'object' ? session.metadata : {};
  const status = text(session.status || session.runtime_monitoring_state || '').toLowerCase();
  const runtimeState = text(session.runtime_monitoring_state || metadata.runtime_state).toLowerCase();
  if (runtimeState === 'failed') return 'failed';
  if (runtimeState === 'stopped') return 'stopped';
  if (status === 'failed') return 'failed';
  if (status === 'stopping') return 'stopping';
  if (status === 'stopped') return 'stopped';
  if (status === 'expired' || isMonitoringSessionExpired(session)) return 'expired';
  if (status === 'starting') return 'connecting';
  if (status === 'active') {
    if (session.active_lease === false) return 'expired';
    return hasRtProof ? 'live punch saved in current session' : 'waiting for new live punch';
  }
  return status || 'disconnected';
}

export function monitoringStatusLabel(session, hasRtProof) {
  const status = effectiveMonitoringStatus(session, hasRtProof);
  if (status === 'expired') return 'expired monitoring session';
  return status;
}

export function syncStatusLabel(syncState) {
  if (!syncState) return 'sync idle';
  const status = text(syncState.status || syncState.command_status || syncState.batch_status).toLowerCase();
  if (status === 'queued' || status === 'sent' || status === 'syncing' || status === 'running') return 'sync running';
  if (status === 'completed' || status === 'accepted' || status === 'success') return 'sync success';
  if (status === 'failed' || status === 'rejected') return 'sync failed';
  return status ? 'sync ' + status : 'sync idle';
}

export function productSafeErrorLabel(value, fallback = 'Operation failed') {
  const message = text(value && value.message ? value.message : value).trim();
  if (value && value.sessionExpired) return 'Session expired. Please sign in again.';
  if (/missing_or_invalid_session|missing_credentials|401|unauthorized/i.test(message)) {
    return 'Session expired. Please sign in again.';
  }
  if (/runtime_reported_state_stale/i.test(message)) {
    return 'Agent status is stale. Waiting for a fresh agent heartbeat.';
  }
  if (/runtime_capability_unknown/i.test(message)) {
    return 'Agent capability is not confirmed yet.';
  }
  if (/device_path_capability_unknown/i.test(message)) {
    return 'Device sync capability needs a fresh readiness check.';
  }
  if (/failed to fetch|network|ECONNREFUSED|timeout/i.test(message)) {
    return 'Backend unavailable.';
  }
  return message || fallback;
}

export function technicalErrorDetails(value) {
  if (!value) return '';
  const details = value.details || value.response || {};
  const code = details.error || details.code || value.code || value.message || '';
  const lastHeartbeat = details.last_heartbeat_at || details.runtime_last_heartbeat_at || '';
  const reportedAt = details.runtime_reported_at || details.reported_at || '';
  return [
    code ? 'Raw code: ' + code + '.' : '',
    lastHeartbeat ? 'Last heartbeat: ' + lastHeartbeat + '.' : '',
    reportedAt ? 'Reported at: ' + reportedAt + '.' : ''
  ].filter(Boolean).join(' ');
}

export function attendanceStatusDisplayLabel(status) {
  const normalized = text(status).trim().toLowerCase();
  if (normalized === 'complete_day') return 'Complete day';
  if (normalized === 'present') return 'Present';
  if (normalized === 'incomplete') return 'Needs review';
  if (normalized === 'invalid') return 'Needs review';
  if (normalized === 'unmapped_device_user') return 'Unmapped device user';
  return normalized ? normalized.replace(/_/g, ' ') : '-';
}

export function attendanceExplanationDisplayLabel(value) {
  const message = Array.isArray(value) ? value.join(' ') : text(value);
  if (/non[-\s]?alternating\s+in\/out\s+sequence/i.test(message)) return 'Punch sequence issue';
  if (/late\s+calculation\s+not\s+configured/i.test(message)) return 'Schedule rules not configured';
  return message;
}

export function rtPersonLabel(row) {
  return row.person_id || row.device_person_id || row.device_user_id || '-';
}

export function rtSourceLabel(row) {
  const rowMeta = row.metadata || row.source_metadata || {};
  return [row.source_lane || row.parser || rowMeta.parser, rowMeta.rt_time_contract_version]
    .filter(Boolean)
    .join(' ') || row.status || '-';
}

function rtMetadata(row) {
  return row && (row.source_metadata || row.metadata) && typeof (row.source_metadata || row.metadata) === 'object'
    ? (row.source_metadata || row.metadata)
    : {};
}

export function isUntrustedDualTimeRtRow(row) {
  const rowMeta = rtMetadata(row);
  return rowMeta.rt_time_contract_version === 'dual_time_v1'
    && rowMeta.rt_time_observed_trust === 'untrusted'
    && rowMeta.rt_time_chronology_source === 'server_ingest_clock';
}

export function rtPrimaryDisplayTime(row) {
  if (isUntrustedDualTimeRtRow(row)) {
    const rowMeta = rtMetadata(row);
    return rowMeta.rt_time_chronology_utc || row.created_at || '';
  }
  return row.observed_at_utc || row.created_at || '';
}

function parseTimeMs(value) {
  const raw = text(value).trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

export function getRtRowSavedAt(row) {
  if (!row) return '';
  return text(row.created_at || '').trim()
    || text(rtPrimaryDisplayTime(row)).trim()
    || text(row.observed_at_utc || '').trim();
}

export function isRtRowInCurrentSession(row, session) {
  if (!row || !session || !session.started_at) return false;
  const rowSavedAt = parseTimeMs(getRtRowSavedAt(row));
  const sessionStartedAt = parseTimeMs(session.started_at);
  if (rowSavedAt === null || sessionStartedAt === null) return false;
  return rowSavedAt >= sessionStartedAt;
}

export function getLatestCurrentSessionRtRow(rtRows, session) {
  const rows = Array.isArray(rtRows) ? rtRows : [];
  return rows
    .filter(row => isRtRowInCurrentSession(row, session))
    .sort((a, b) => (parseTimeMs(getRtRowSavedAt(b)) || 0) - (parseTimeMs(getRtRowSavedAt(a)) || 0))[0] || null;
}

export function getLatestHistoricalRtRow(rtRows, session) {
  const rows = Array.isArray(rtRows) ? rtRows : [];
  return rows
    .filter(row => !isRtRowInCurrentSession(row, session))
    .sort((a, b) => (parseTimeMs(getRtRowSavedAt(b)) || 0) - (parseTimeMs(getRtRowSavedAt(a)) || 0))[0] || null;
}

export function liveSessionState(rtRows, session) {
  const currentRow = getLatestCurrentSessionRtRow(rtRows, session);
  const historicalRow = getLatestHistoricalRtRow(rtRows, session);
  const hasSession = Boolean(session);
  const status = effectiveMonitoringStatus(session, false);
  if (!hasSession) {
    return {
      state: historicalRow ? 'old_live_punches_only' : 'no_monitoring_session',
      hasCurrentSessionProof: false,
      currentRow,
      historicalRow,
      label: historicalRow ? 'Old live punches only' : 'Monitoring inactive'
    };
  }
  if (status === 'expired') {
    return {
      state: 'session_expired',
      hasCurrentSessionProof: false,
      currentRow,
      historicalRow,
      label: 'Session expired'
    };
  }
  if (status !== 'connecting' && status !== 'active' && status !== 'waiting for new live punch') {
    return {
      state: status || 'monitoring_inactive',
      hasCurrentSessionProof: false,
      currentRow,
      historicalRow,
      label: monitoringStatusLabel(session, false)
    };
  }
  if (currentRow) {
    return {
      state: 'current_session_live_punch_saved',
      hasCurrentSessionProof: true,
      currentRow,
      historicalRow,
      label: 'Live punch saved in current session'
    };
  }
  return {
    state: historicalRow ? 'old_live_punches_only' : 'waiting_for_new_live_punch',
    hasCurrentSessionProof: false,
    currentRow,
    historicalRow,
    label: historicalRow ? 'Old live punches only' : 'Waiting for new live punch'
  };
}

export function rtUntrustedObservedTimeLabel(row) {
  if (!isUntrustedDualTimeRtRow(row)) return '';
  const rowMeta = rtMetadata(row);
  return rowMeta.rt_time_decoded_local
    || row.observed_at_local
    || rowMeta.rt_time_decoded_utc
    || row.observed_at_utc
    || '';
}

export function rtPersistenceHealthSummary(batch) {
  if (!batch) return null;
  const safeSummary = batch.rt_diagnostics_summary && typeof batch.rt_diagnostics_summary === 'object'
    ? batch.rt_diagnostics_summary
    : null;
  if (safeSummary) {
    const ingestMethod = text(safeSummary.ingest_method);
    const eventsReceived = Number(safeSummary.events_received_count || 0);
    const inserted = Number(safeSummary.inserted_count || 0);
    const skipped = safeSummary.k80_rt_ingest_insert_path_skipped === true;
    const skipReason = text(safeSummary.k80_rt_ingest_insert_path_skip_reason);
    if (ingestMethod === 'agent_realtime' && eventsReceived > 0 && inserted === 0 && (skipped || skipReason)) {
      return {
        label: safeSummary.k80_rt_ingest_policy_enabled === false
          || /policy_disabled/i.test(skipReason)
          ? 'Live capture received, persistence disabled'
          : 'Live capture received, not saved',
        events_received_count: eventsReceived,
        inserted_count: inserted,
        k80_rt_ingest_policy_enabled: safeSummary.k80_rt_ingest_policy_enabled,
        k80_rt_ingest_insert_path_skipped: skipped,
        skip_reason: skipReason || 'not_saved'
      };
    }
  }
  const payload = batch.payload && typeof batch.payload === 'object' ? batch.payload : {};
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  const diagnostics = summary.diagnostics && typeof summary.diagnostics === 'object' ? summary.diagnostics : {};
  const ingestMethod = summary.ingest_method || payload.ingest_method || batch.ingest_method || '';
  const eventsReceived = Number(summary.events_received_count ?? batch.events_received_count ?? 0);
  const inserted = Number(summary.inserted_count ?? batch.inserted_count ?? 0);
  const skipped = diagnostics.k80_rt_ingest_insert_path_skipped === true;
  const skipReason = diagnostics.k80_rt_ingest_insert_path_skip_reason
    || diagnostics.skip_reason
    || diagnostics.k80_rt_ingest_skip_reason
    || '';
  if (ingestMethod === 'agent_realtime' && eventsReceived > 0 && inserted === 0 && (skipped || skipReason)) {
    return {
      label: diagnostics.k80_rt_ingest_policy_enabled === false
        ? 'Live capture received, persistence disabled'
        : 'Live capture received, not saved',
      events_received_count: eventsReceived,
      inserted_count: inserted,
      k80_rt_ingest_policy_enabled: diagnostics.k80_rt_ingest_policy_enabled,
      k80_rt_ingest_insert_path_skipped: skipped,
      skip_reason: skipReason || 'not_saved'
    };
  }
  return null;
}
