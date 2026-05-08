import { setCurrentModule, bindModuleNavigation } from './modules.js';
import { loadCompanies, bindSettings, renderSites, loadSettingsEvidence } from './settings.js';
import { loadDevices } from './operations.js';
import { refreshRtRows, openSse } from './realtime.js';
import { bindMonitoring } from './monitoring.js';
import { bindRealtime } from './realtime.js';
import { bindSync } from './sync.js';
import { byId, setStatus } from './renderHelpers.js';
import { bindAuth, loadAuth } from './auth.js';
import { bindEmployees, loadEmployees } from './employees.js';
import { bindAttendance, loadAttendance } from './attendance.js';
import { state } from './state.js';

function redirectToLogin(reason = 'session_expired') {
  if (state.auth.sessionExpired) return;
  state.auth.sessionExpired = true;
  setStatus('Session expired. Redirecting to login.');
  const target = new URL('/login/', window.location.origin);
  target.searchParams.set('reason', reason);
  window.location.assign(target.toString());
}

async function refreshAll() {
  setStatus('Loading.');
  await loadCompanies();
  await loadDevices();
  await loadSettingsEvidence();
  renderSites();
  await loadEmployees();
  await loadAttendance();
  await refreshRtRows();
  openSse();
  setStatus('Ready.');
}

function bind() {
  window.addEventListener('app:session-expired', () => redirectToLogin('session_expired'));
  bindAuth();
  bindModuleNavigation();
  bindSettings();
  bindMonitoring();
  bindRealtime();
  bindSync();
  bindEmployees();
  bindAttendance();
  byId('refreshWorkspace').addEventListener('click', () => refreshAll().catch(err => setStatus('Refresh failed: ' + err.message)));
}

async function init() {
  bind();
  setCurrentModule('operations');
  try {
    await loadAuth();
    await refreshAll();
  } catch (err) {
    if (err && err.status === 401) {
      redirectToLogin('session_expired');
      return;
    }
    setStatus('Load failed: ' + err.message);
  }
}

document.addEventListener('DOMContentLoaded', init);
