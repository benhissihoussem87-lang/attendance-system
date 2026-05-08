import { request } from './apiClient.js';
import { state } from './state.js';
import { byId, setStatus } from './renderHelpers.js';

const ROLE_RANK = {
  viewer: 1,
  operator: 2,
  admin: 3
};

export function hasRole(minRole) {
  const role = state.auth && state.auth.role ? state.auth.role : '';
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || 0);
}

export async function loadAuth() {
  const data = await request('GET', '/api/auth/me');
  const user = data && data.user ? data.user : null;
  if (!user) {
    throw new Error('missing_user');
  }
  state.auth.user = user;
  state.auth.role = user.role || '';
  state.auth.companyId = user.company_id || '';
  state.auth.loaded = true;
  renderAuthState();
  return user;
}

export function renderAuthState() {
  const target = byId('authState');
  if (!target) return;
  const user = state.auth && state.auth.user;
  target.textContent = user ? `${user.email} · ${user.role} · ${user.company_id}` : 'Not signed in.';
  document.querySelectorAll('[data-requires-role]').forEach(element => {
    const allowed = hasRole(element.getAttribute('data-requires-role'));
    element.hidden = !allowed;
    if ('disabled' in element) element.disabled = !allowed;
  });
  const settingsButton = document.querySelector('[data-module="settings"]');
  if (settingsButton) {
    settingsButton.hidden = !hasRole('admin');
  }
}

export async function logout() {
  await request('POST', '/api/auth/logout', {});
  window.location.assign('/login/');
}

export function bindAuth() {
  const logoutButton = byId('logoutButton');
  if (logoutButton) {
    logoutButton.addEventListener('click', () => logout().catch(err => setStatus('Logout failed: ' + err.message)));
  }
}
