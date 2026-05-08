import { text } from './renderHelpers.js';

export function appUrl(path, query) {
  const built = new URL(path, window.location.origin + '/');
  Object.keys(query || {}).forEach(key => {
    const value = query[key];
    if (value === undefined || value === null || text(value).trim() === '') return;
    built.searchParams.set(key, value);
  });
  return built.toString();
}

async function parseResponse(response) {
  const raw = await response.text();
  let body = null;
  if (raw) {
    try { body = JSON.parse(raw); } catch (_) { body = { raw }; }
  }
  if (!response.ok) {
    const details = body && typeof body.details === 'object' && body.details ? body.details : null;
    const detailMessage = details && (details.error || details.reason || details.code || details.detail);
    const genericTopLevel = body && (body.error === 'conflict' || body.error === 'bad_request' || body.error === 'error');
    const message = body && ((genericTopLevel ? null : body.error) || detailMessage || body.message || body.raw)
      ? ((genericTopLevel ? null : body.error) || detailMessage || body.message || body.raw)
      : 'HTTP ' + response.status;
    const err = new Error(String(message));
    err.status = response.status;
    err.body = body;
    err.details = details;
    if (isSessionExpiredResponse(response, body)) {
      err.sessionExpired = true;
      notifySessionExpired(err);
    }
    throw err;
  }
  return body;
}

function isSessionExpiredResponse(response, body) {
  if (!response || response.status !== 401) return false;
  const details = body && typeof body.details === 'object' && body.details ? body.details : {};
  const markers = [
    body && body.error,
    body && body.message,
    details.error,
    details.reason,
    details.code,
    details.detail
  ].map(value => text(value).toLowerCase());
  return markers.some(value => value === 'unauthorized'
    || value === 'missing_or_invalid_session'
    || value === 'missing_credentials'
    || value.includes('session'));
}

function notifySessionExpired(err) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app:session-expired', {
    detail: {
      status: err.status,
      message: err.message,
      details: err.details || {}
    }
  }));
}

export async function request(method, path, body, query) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(appUrl(path, query), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  });
  return parseResponse(response);
}
