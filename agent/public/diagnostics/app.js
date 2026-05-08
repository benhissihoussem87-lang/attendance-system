(function () {
  const refreshBtn = document.getElementById('refreshBtn');
  const lastRefreshLabel = document.getElementById('lastRefreshLabel');
  const summaryRuntime = document.getElementById('summaryRuntime');
  const summarySaas = document.getElementById('summarySaas');
  const summaryPolling = document.getElementById('summaryPolling');
  const summaryBuffered = document.getElementById('summaryBuffered');
  const summaryMessage = document.getElementById('summaryMessage');
  const summaryHints = document.getElementById('summaryHints');
  const historyHealth = document.getElementById('historyHealth');
  const historyHealthReason = document.getElementById('historyHealthReason');
  const historyLastSuccess = document.getElementById('historyLastSuccess');
  const historyLastSuccessDetail = document.getElementById('historyLastSuccessDetail');
  const historyLastFailure = document.getElementById('historyLastFailure');
  const historyLastFailureDetail = document.getElementById('historyLastFailureDetail');
  const historyFailurePattern = document.getElementById('historyFailurePattern');
  const historyFailurePatternDetail = document.getElementById('historyFailurePatternDetail');
  const agentMeta = document.getElementById('agentMeta');
  const commandsMeta = document.getElementById('commandsMeta');
  const activityBody = document.querySelector('#activityTable tbody');
  const activityEmpty = document.getElementById('activityEmpty');
  const devicesBody = document.querySelector('#devicesTable tbody');
  const devicesEmpty = document.getElementById('devicesEmpty');

  function safeText(value, fallback) {
    if (value === null || value === undefined) {
      return fallback;
    }
    const text = String(value).trim();
    return text || fallback;
  }

  function formatIso(value) {
    if (!value) {
      return 'Not yet';
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }
    return parsed.toLocaleString();
  }

  function formatAge(ageMs) {
    if (!Number.isFinite(ageMs)) {
      return 'n/a';
    }
    if (ageMs < 1000) {
      return 'just now';
    }
    const sec = Math.floor(ageMs / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  }

  function setStatusPill(node, label, tone) {
    node.textContent = label;
    node.dataset.state = tone;
  }

  function toneForStatus(status) {
    if (status === 'connected' || status === 'fresh' || status === 'healthy') {
      return 'good';
    }
    if (status === 'degraded' || status === 'stale' || status === 'attention') {
      return 'warn';
    }
    if (status === 'failed' || status === 'offline') {
      return 'bad';
    }
    return 'warn';
  }

  function parseIsoMs(value) {
    if (!value) {
      return null;
    }
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }

  function pickLatest(entries) {
    let best = null;
    entries.forEach(entry => {
      if (!entry) {
        return;
      }
      const atMs = parseIsoMs(entry.at);
      if (atMs === null) {
        return;
      }
      if (!best || atMs > best.atMs) {
        best = { ...entry, atMs };
      }
    });
    return best;
  }

  function deriveHealthLevel(snapshot) {
    const support = snapshot.support_summary || {};
    const saas = snapshot.saas_connectivity || {};
    const polling = snapshot.command_polling || {};
    const primaryIssue = safeText(support.primary_issue, '');

    if (support.status === 'healthy' && saas.status === 'connected' && polling.status === 'fresh') {
      return {
        label: 'Healthy',
        tone: 'good',
        reason: 'Agent, SaaS heartbeat, and command polling are all healthy.'
      };
    }

    if (primaryIssue === 'recent_command_failure') {
      return {
        label: 'Blocked',
        tone: 'bad',
        reason: 'Latest command execution failed; check failure details below.'
      };
    }

    if (primaryIssue === 'heartbeat_stale' || primaryIssue === 'polling_stale' || saas.status === 'degraded' || polling.status === 'stale') {
      return {
        label: 'Degraded',
        tone: 'warn',
        reason: 'Runtime is up but heartbeat or polling freshness is degraded.'
      };
    }

    if (primaryIssue === 'saas_connectivity_not_proven') {
      return {
        label: 'Unknown',
        tone: 'warn',
        reason: 'SaaS connectivity has not been proven yet from this runtime.'
      };
    }

    return {
      label: 'Unknown',
      tone: 'warn',
      reason: safeText(support.summary, 'Health level cannot be fully determined yet.')
    };
  }

  function latestDeviceCommunicationFailure(snapshot) {
    const devices = Array.isArray(snapshot.devices) ? snapshot.devices : [];
    const candidates = [];
    devices.forEach(device => {
      if (device && device.last_pull && device.last_pull.status === 'failed') {
        candidates.push({
          at: device.last_pull.completed_at,
          source: 'Device pull',
          detail: `${safeText(device.device_uid, 'unknown device')} (${safeText(device.last_pull.reason_code, 'failure')})`
        });
      }
      if (device && device.last_validation && device.last_validation.status === 'failed') {
        candidates.push({
          at: device.last_validation.completed_at,
          source: 'Device validation',
          detail: `${safeText(device.device_uid, 'unknown device')} (${safeText(device.last_validation.reason_code, 'failure')})`
        });
      }
    });
    return pickLatest(candidates);
  }

  function buildHistorySummary(snapshot) {
    const saas = snapshot.saas_connectivity || {};
    const polling = snapshot.command_polling || {};
    const commands = snapshot.commands || {};

    const latestSuccess = pickLatest([
      commands.last_success && {
        at: commands.last_success.completed_at,
        source: `Command ${safeText(commands.last_success.command_type, '')}`,
        detail: safeText(commands.last_success.reason_code, 'succeeded')
      },
      {
        at: saas.last_success_at,
        source: 'SaaS heartbeat',
        detail: 'Latest successful SaaS contact'
      },
      {
        at: polling.last_success_at,
        source: 'Command polling',
        detail: 'Latest successful poll loop'
      }
    ]);

    const latestDeviceFailure = latestDeviceCommunicationFailure(snapshot);
    const latestFailure = pickLatest([
      commands.last_failure && {
        at: commands.last_failure.completed_at,
        source: `Command ${safeText(commands.last_failure.command_type, '')}`,
        detail: safeText(commands.last_failure.reason_code, 'failed')
      },
      latestDeviceFailure && {
        at: latestDeviceFailure.at,
        source: latestDeviceFailure.source,
        detail: latestDeviceFailure.detail
      },
      {
        at: polling.last_failure_at,
        source: 'Command polling',
        detail: safeText(polling.last_error, 'polling failed')
      },
      {
        at: saas.last_failure_at,
        source: 'SaaS heartbeat',
        detail: safeText(saas.last_error, 'heartbeat failed')
      }
    ]);

    const recent = Array.isArray(commands.recent) ? commands.recent : [];
    const recentFailures = recent
      .filter(item => item && item.level === 'warn')
      .filter(item => {
        const ms = parseIsoMs(item.ts);
        return ms !== null && (Date.now() - ms) <= (20 * 60 * 1000);
      });
    const repeating = recentFailures.length >= 3;

    let failurePatternLabel = 'No recent failures';
    let failurePatternTone = 'good';
    let failurePatternDetail = 'No warning-level failures seen in the last 20 minutes.';
    if (latestFailure) {
      const latestSuccessMs = latestSuccess ? latestSuccess.atMs : null;
      const latestFailureMs = latestFailure.atMs;
      if (repeating) {
        failurePatternLabel = 'Repeating failure';
        failurePatternTone = 'bad';
        failurePatternDetail = `${recentFailures.length} warning events were recorded in the last 20 minutes.`;
      } else if (latestSuccessMs !== null && latestFailureMs < latestSuccessMs) {
        failurePatternLabel = 'Historical residue';
        failurePatternTone = 'warn';
        failurePatternDetail = 'Latest failure is older than the latest success; monitor but it may already be recovered.';
      } else {
        failurePatternLabel = 'Recent isolated failure';
        failurePatternTone = 'warn';
        failurePatternDetail = 'A recent failure exists, but repeating pattern is not yet confirmed.';
      }
    }

    return {
      latestSuccess,
      latestFailure,
      failurePatternLabel,
      failurePatternTone,
      failurePatternDetail
    };
  }

  function renderHistory(snapshot) {
    const health = deriveHealthLevel(snapshot);
    const history = buildHistorySummary(snapshot);

    setStatusPill(historyHealth, health.label, health.tone);
    historyHealthReason.textContent = health.reason;

    historyLastSuccess.textContent = history.latestSuccess ? formatIso(history.latestSuccess.at) : 'Not yet';
    historyLastSuccessDetail.textContent = history.latestSuccess
      ? `${history.latestSuccess.source}: ${history.latestSuccess.detail}`
      : 'No successful command, heartbeat, or polling evidence yet.';

    historyLastFailure.textContent = history.latestFailure ? formatIso(history.latestFailure.at) : 'None';
    historyLastFailureDetail.textContent = history.latestFailure
      ? `${history.latestFailure.source}: ${history.latestFailure.detail}`
      : 'No command/device communication failure recorded.';

    setStatusPill(historyFailurePattern, history.failurePatternLabel, history.failurePatternTone);
    historyFailurePatternDetail.textContent = history.failurePatternDetail;
  }

  function renderSummary(snapshot) {
    const support = snapshot.support_summary || {};
    const saas = snapshot.saas_connectivity || {};
    const polling = snapshot.command_polling || {};

    setStatusPill(summaryRuntime, support.status === 'healthy' ? 'Running' : 'Needs Attention', toneForStatus(support.status));
    setStatusPill(summarySaas, safeText(saas.status, 'Unknown'), toneForStatus(saas.status));
    setStatusPill(summaryPolling, safeText(polling.status, 'Unknown'), toneForStatus(polling.status));
    summaryBuffered.textContent = String(Number.isInteger(snapshot.buffered_event_batches) ? snapshot.buffered_event_batches : 0);
    summaryMessage.textContent = safeText(support.summary, 'No summary available.');

    summaryHints.innerHTML = '';
    const hints = Array.isArray(support.hints) ? support.hints : [];
    if (hints.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No additional local diagnostics hints right now.';
      summaryHints.appendChild(li);
      return;
    }
    hints.forEach(hint => {
      const li = document.createElement('li');
      li.textContent = safeText(hint, '');
      summaryHints.appendChild(li);
    });
  }

  function addMetaPair(listNode, key, value) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    listNode.appendChild(dt);
    listNode.appendChild(dd);
  }

  function renderAgentMeta(snapshot) {
    const agent = snapshot.agent || {};
    const saas = snapshot.saas_connectivity || {};
    const polling = snapshot.command_polling || {};
    agentMeta.innerHTML = '';
    addMetaPair(agentMeta, 'Agent Name', safeText(agent.agent_name, 'Unknown'));
    addMetaPair(agentMeta, 'Agent ID', safeText(agent.agent_id, 'Unknown'));
    addMetaPair(agentMeta, 'Company', safeText(agent.company_id, 'Unknown'));
    addMetaPair(agentMeta, 'SaaS Base URL', safeText(agent.base_url, 'Unknown'));
    addMetaPair(agentMeta, 'Version', safeText(agent.version, 'Unknown'));
    addMetaPair(agentMeta, 'Runtime Uptime', `${Number.isFinite(agent.uptime_sec) ? agent.uptime_sec : 0}s`);
    addMetaPair(agentMeta, 'Started', formatIso(agent.started_at));
    addMetaPair(
      agentMeta,
      'Last Heartbeat',
      `${formatIso(saas.last_success_at)} (${formatAge(saas.freshness && saas.freshness.age_ms)})`
    );
    addMetaPair(
      agentMeta,
      'Last Poll',
      `${formatIso(polling.last_success_at)} (${formatAge(polling.freshness && polling.freshness.age_ms)})`
    );
    addMetaPair(agentMeta, 'Last Poll Error', safeText(polling.last_error, 'None'));
  }

  function renderCommands(snapshot) {
    const commands = snapshot.commands || {};
    const lastReceived = commands.last_received || {};
    const lastSuccess = commands.last_success || {};
    const lastFailure = commands.last_failure || {};

    commandsMeta.innerHTML = '';
    commandsMeta.appendChild(document.createTextNode(`Last command: ${safeText(lastReceived.command_type, 'None')} (${safeText(lastReceived.command_id, 'n/a')})`));
    commandsMeta.appendChild(document.createTextNode(` | Last success: ${safeText(lastSuccess.command_type, 'None')} @ ${formatIso(lastSuccess.completed_at)}`));
    commandsMeta.appendChild(document.createTextNode(` | Last failure: ${safeText(lastFailure.command_type, 'None')} @ ${formatIso(lastFailure.completed_at)}`));

    const recent = Array.isArray(commands.recent) ? commands.recent.slice(0, 20) : [];
    activityBody.innerHTML = '';
    activityEmpty.hidden = recent.length > 0;
    if (recent.length === 0) {
      return;
    }
    recent.forEach(item => {
      const tr = document.createElement('tr');
      const detailsObj = item && item.details && typeof item.details === 'object'
        ? item.details
        : {};
      const details = [
        detailsObj.reason_code,
        detailsObj.error,
        detailsObj.status ? `status=${detailsObj.status}` : '',
        detailsObj.device_uid
      ].filter(Boolean).join(' | ');
      tr.innerHTML = `
        <td>${formatIso(item.ts)}</td>
        <td class="mono">${safeText(item.kind, '-')}</td>
        <td>${safeText(item.message, '-')}</td>
        <td class="mono">${safeText(details || JSON.stringify(detailsObj), '-')}</td>
      `;
      activityBody.appendChild(tr);
    });
  }

  function renderDevices(snapshot) {
    const devices = Array.isArray(snapshot.devices) ? snapshot.devices : [];
    devicesBody.innerHTML = '';
    devicesEmpty.hidden = devices.length > 0;
    if (devices.length === 0) {
      return;
    }
    devices.slice(0, 60).forEach(device => {
      const validation = device.last_validation
        ? `${safeText(device.last_validation.status, 'unknown')} (${safeText(device.last_validation.reason_code, 'n/a')}) @ ${formatIso(device.last_validation.completed_at)}`
        : 'Not validated yet';
      const pull = device.last_pull
        ? `${safeText(device.last_pull.status, 'unknown')} (${safeText(device.last_pull.reason_code, 'n/a')})`
          + `, events: ${safeText(device.last_pull.event_count, 'n/a')} @ ${formatIso(device.last_pull.completed_at)}`
        : 'No pull result yet';

      const profile = [
        safeText(device.host, 'host n/a'),
        device.port ? `:${device.port}` : '',
        safeText(device.transport, ''),
        safeText(device.attlog_sequence, '')
      ].filter(Boolean).join(' ');

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div class="mono">${safeText(device.device_uid, 'unknown')}</div>
          <div>${safeText(device.provider, 'provider n/a')}</div>
        </td>
        <td class="mono">${safeText(profile, 'No connection profile captured yet')}</td>
        <td>${validation}</td>
        <td>${pull}</td>
        <td>${formatIso(device.last_command_received_at)}</td>
      `;
      devicesBody.appendChild(tr);
    });
  }

  async function loadSnapshot() {
    const response = await fetch('/api/local-diagnostics', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Diagnostics request failed (${response.status})`);
    }
    return response.json();
  }

  async function refresh() {
    refreshBtn.disabled = true;
    try {
      const snapshot = await loadSnapshot();
      renderSummary(snapshot);
      renderHistory(snapshot);
      renderAgentMeta(snapshot);
      renderCommands(snapshot);
      renderDevices(snapshot);
      lastRefreshLabel.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      summaryMessage.textContent = err && err.message ? err.message : 'Failed to load diagnostics data.';
      lastRefreshLabel.textContent = 'Refresh failed';
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', () => {
    refresh();
  });

  refresh();
  setInterval(refresh, 8000);
})();
