(function () {
  const STORAGE_KEYS = {
    baseUrl: 'mvp.baseUrl',
    companyId: 'mvp.companyId',
    apiKey: 'mvp.apiKey',
    vendor: 'mvp.csvVendor',
    delimiter: 'mvp.csvDelimiter',
    attendanceDateFrom: 'mvp.attendanceDateFrom',
    attendanceDateTo: 'mvp.attendanceDateTo',
    attendancePersonId: 'mvp.attendancePersonId',
    employeesPersonId: 'mvp.employeesPersonId'
  };

  const state = {
    previewReady: false
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function toJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (err) {
      return String(value);
    }
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return window.location.origin;
    }
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return raw.replace(/\/+$/, '');
    }
    return ('http://' + raw).replace(/\/+$/, '');
  }

  function todayIso() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  function parseIsoDate(value, label) {
    const raw = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error(label + ' must be YYYY-MM-DD.');
    }
    const parsed = new Date(raw + 'T00:00:00Z');
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(label + ' must be a valid date.');
    }
    return parsed;
  }

  function dateToIso(date) {
    return date.toISOString().slice(0, 10);
  }

  function buildIsoDateRange(fromRaw, toRaw) {
    const fromDate = parseIsoDate(fromRaw, 'date_from');
    const toDate = parseIsoDate(toRaw, 'date_to');
    if (fromDate.getTime() > toDate.getTime()) {
      throw new Error('date_from must be less than or equal to date_to.');
    }
    const dates = [];
    const cursor = new Date(fromDate.getTime());
    while (cursor.getTime() <= toDate.getTime()) {
      dates.push(dateToIso(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (dates.length > 31) {
        throw new Error('Date range is too large (max 31 days).');
      }
    }
    return dates;
  }

  function getContext() {
    const baseUrl = normalizeBaseUrl(byId('baseUrl').value);
    const companyId = String(byId('companyId').value || '').trim() || 'DEFAULT';
    const apiKey = String(byId('apiKey').value || '').trim();
    return { baseUrl, companyId, apiKey };
  }

  function getAuthHeaders() {
    const ctx = getContext();
    if (!ctx.apiKey) {
      return {};
    }
    return { 'x-api-key': ctx.apiKey };
  }

  function sanitizeHeadersForLog(headers) {
    const source = headers && typeof headers === 'object' ? headers : {};
    const sanitized = {};
    Object.keys(source).forEach(key => {
      if (key.toLowerCase() === 'x-api-key') {
        sanitized[key] = '***redacted***';
      } else {
        sanitized[key] = source[key];
      }
    });
    return sanitized;
  }

  function isErrorEnvelope(payload) {
    return Boolean(
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      typeof payload.error === 'string' &&
      typeof payload.code === 'string' &&
      typeof payload.message === 'string'
    );
  }

  function clearErrorEnvelope() {
    const container = byId('errorEnvelope');
    if (!container) {
      return;
    }
    container.classList.add('hidden');
    byId('envCode').textContent = '-';
    byId('envMessage').textContent = '-';
    byId('envKind').textContent = '-';
    byId('envError').textContent = '-';
    byId('envDetailsJson').textContent = '';
  }

  function renderErrorEnvelope(envelope) {
    const container = byId('errorEnvelope');
    if (!container) {
      return;
    }
    const details = (
      envelope &&
      envelope.details &&
      typeof envelope.details === 'object' &&
      !Array.isArray(envelope.details)
    ) ? envelope.details : null;

    byId('envCode').textContent = envelope.code || '-';
    byId('envMessage').textContent = envelope.message || '-';
    byId('envKind').textContent = details && details.kind ? String(details.kind) : '-';
    byId('envError').textContent = details && details.error ? String(details.error) : '-';

    if (details) {
      const extras = {};
      Object.keys(details).forEach(key => {
        if (key !== 'kind' && key !== 'error') {
          extras[key] = details[key];
        }
      });
      byId('envDetailsJson').textContent = Object.keys(extras).length > 0 ? toJson(extras) : '';
    } else {
      byId('envDetailsJson').textContent = '';
    }

    container.classList.remove('hidden');
  }

  function setRequestState(kind, text, payload) {
    const statusEl = byId('requestStatus');
    statusEl.className = 'status';
    if (kind === 'ok') {
      statusEl.classList.add('ok');
    } else if (kind === 'err') {
      statusEl.classList.add('err');
    }
    statusEl.textContent = text;
    byId('requestPayload').textContent = payload ? toJson(payload) : '';
  }

  function buildUrl(pathname, query) {
    const ctx = getContext();
    const url = new URL(pathname, ctx.baseUrl + '/');
    if (query && typeof query === 'object') {
      Object.keys(query).forEach(key => {
        const value = query[key];
        if (value === undefined || value === null) {
          return;
        }
        const text = String(value).trim();
        if (text.length === 0) {
          return;
        }
        url.searchParams.set(key, text);
      });
    }
    return url;
  }

  async function parseResponse(res) {
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      try {
        return await res.json();
      } catch (err) {
        return { parse_error: 'json_parse_failed' };
      }
    }
    return res.text();
  }

  async function requestApi(options) {
    const method = options.method || 'GET';
    const url = buildUrl(options.path, options.query);
    const headers = Object.assign({}, getAuthHeaders(), options.headers || {});

    let body = options.body;
    if (body !== undefined && body !== null && typeof body !== 'string') {
      body = JSON.stringify(body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
    if (typeof body === 'string' && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'text/plain';
    }

    const requestMeta = {
      method,
      url: url.toString(),
      headers: sanitizeHeadersForLog(headers)
    };
    clearErrorEnvelope();
    setRequestState('info', method + ' ' + url.pathname + ' ...', requestMeta);

    const res = await fetch(url.toString(), {
      method,
      headers,
      body
    });
    const data = await parseResponse(res);
    const resultMeta = {
      status: res.status,
      ok: res.ok,
      body: data
    };

    if (!res.ok) {
      if (isErrorEnvelope(data)) {
        renderErrorEnvelope(data);
      } else {
        clearErrorEnvelope();
      }
      setRequestState('err', method + ' ' + url.pathname + ' -> HTTP ' + res.status, resultMeta);
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      err.payload = data;
      throw err;
    }

    clearErrorEnvelope();
    setRequestState('ok', method + ' ' + url.pathname + ' -> HTTP ' + res.status, resultMeta);
    return {
      status: res.status,
      data,
      headers: res.headers
    };
  }

  function persistInputs() {
    const ctx = getContext();
    localStorage.setItem(STORAGE_KEYS.baseUrl, ctx.baseUrl);
    localStorage.setItem(STORAGE_KEYS.companyId, ctx.companyId);
    localStorage.setItem(STORAGE_KEYS.apiKey, ctx.apiKey);
    localStorage.setItem(STORAGE_KEYS.vendor, byId('csvVendor').value || '');
    localStorage.setItem(STORAGE_KEYS.delimiter, byId('csvDelimiter').value || '');
    localStorage.setItem(STORAGE_KEYS.attendanceDateFrom, byId('attendanceDateFrom').value || '');
    localStorage.setItem(STORAGE_KEYS.attendanceDateTo, byId('attendanceDateTo').value || '');
    localStorage.setItem(STORAGE_KEYS.attendancePersonId, byId('attendancePersonId').value || '');
    localStorage.setItem(STORAGE_KEYS.employeesPersonId, byId('employeesPersonId').value || '');
  }

  function restoreInputs() {
    const today = todayIso();
    byId('baseUrl').value = localStorage.getItem(STORAGE_KEYS.baseUrl) || window.location.origin;
    byId('companyId').value = localStorage.getItem(STORAGE_KEYS.companyId) || 'DEFAULT';
    byId('apiKey').value = localStorage.getItem(STORAGE_KEYS.apiKey) || '';
    byId('csvVendor').value = localStorage.getItem(STORAGE_KEYS.vendor) || '';
    byId('csvDelimiter').value = localStorage.getItem(STORAGE_KEYS.delimiter) || '';
    byId('attendanceDateFrom').value = localStorage.getItem(STORAGE_KEYS.attendanceDateFrom) || today;
    byId('attendanceDateTo').value = localStorage.getItem(STORAGE_KEYS.attendanceDateTo) || today;
    byId('attendancePersonId').value = localStorage.getItem(STORAGE_KEYS.attendancePersonId) || '';
    byId('employeesPersonId').value = localStorage.getItem(STORAGE_KEYS.employeesPersonId) || '';
    byId('employeesMetadata').value = '{}';
    byId('upsertMetadata').value = '{}';
  }

  function setCsvButtonsDisabled(disabled) {
    byId('btnPreview').disabled = disabled;
    byId('btnCommit').disabled = disabled || !state.previewReady;
    byId('btnExportErrors').disabled = disabled;
  }

  function switchPage(page) {
    const pages = {
      csv: byId('pageCsv'),
      attendance: byId('pageAttendance'),
      employees: byId('pageEmployees'),
      devices: byId('pageDevices'),
      bridgeOps: byId('pageBridgeOps')
    };
    const tabs = {
      csv: byId('tabCsv'),
      attendance: byId('tabAttendance'),
      employees: byId('tabEmployees'),
      devices: byId('tabDevices'),
      bridgeOps: byId('tabBridgeOps')
    };

    const active = Object.prototype.hasOwnProperty.call(pages, page) ? page : 'csv';
    Object.keys(pages).forEach(key => {
      const pageEl = pages[key];
      const tabEl = tabs[key];
      if (pageEl) {
        pageEl.classList.toggle('hidden', key !== active);
      }
      if (tabEl) {
        tabEl.classList.toggle('tab-active', key === active);
      }
    });
  }

  function renderMetrics(result) {
    const body = byId('csvMetricsBody');
    const keys = [
      'system_version',
      'contract',
      'import_version',
      'total_rows',
      'valid_rows',
      'invalid_rows',
      'inserted_rows',
      'skipped_rows',
      'failed_rows'
    ];
    const rows = keys.filter(key => result[key] !== undefined);
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="2" class="muted">No metrics</td></tr>';
      return;
    }
    body.innerHTML = rows.map(key => (
      '<tr><td>' + escapeHtml(key) + '</td><td>' + escapeHtml(result[key]) + '</td></tr>'
    )).join('');
  }

  function renderErrors(result) {
    const errors = Array.isArray(result.errors) ? result.errors : [];
    const body = byId('csvErrorsBody');
    if (errors.length === 0) {
      body.innerHTML = '<tr><td colspan="3" class="muted">No errors</td></tr>';
      return;
    }
    body.innerHTML = errors.slice(0, 100).map(err => {
      const row = err.row_number !== undefined ? err.row_number : '-';
      const code = err.code !== undefined ? err.code : '-';
      const message = err.message !== undefined ? err.message : '-';
      return '<tr><td>' + escapeHtml(row) + '</td><td>' + escapeHtml(code) + '</td><td>' + escapeHtml(message) + '</td></tr>';
    }).join('');
  }

  function normalizeSampleRows(payload) {
    if (!payload || typeof payload !== 'object') {
      return [];
    }
    if (Array.isArray(payload.sample_valid_rows)) {
      return payload.sample_valid_rows;
    }
    if (Array.isArray(payload.sample_rows)) {
      return payload.sample_rows;
    }
    if (Array.isArray(payload.inserted_samples)) {
      return payload.inserted_samples;
    }

    const inserted = payload.inserted_samples;
    if (!inserted || typeof inserted !== 'object') {
      return [];
    }

    const first3 = Array.isArray(inserted.first3) ? inserted.first3 : [];
    const last3 = Array.isArray(inserted.last3) ? inserted.last3 : [];
    const combined = first3.concat(last3);
    const deduped = [];
    const seen = new Set();

    for (const row of combined) {
      const rowNumber = row && row.row_number !== undefined ? row.row_number : '';
      const data = row && row.data ? row.data : row;
      let stableData = '';
      try {
        stableData = JSON.stringify(data);
      } catch (err) {
        stableData = String(data);
      }
      const key = String(rowNumber) + '|' + stableData;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(row);
    }

    return deduped;
  }

  function renderSamples(result) {
    const source = normalizeSampleRows(result);
    const body = byId('csvSampleBody');
    if (source.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="muted">No sample rows</td></tr>';
      return;
    }
    body.innerHTML = source.slice(0, 100).map(row => {
      const data = row && row.data ? row.data : row;
      const rowNumber = row && row.row_number !== undefined ? row.row_number : '-';
      const person = data && (data.resolved_person_id || data.person_id || '-');
      const eventTime = data && (data.event_time || data.event_time_utc || '-');
      const direction = data && data.direction ? data.direction : '-';
      const deviceUid = data && data.device_uid ? data.device_uid : '-';
      const vendor = data && data.vendor ? data.vendor : '-';
      return (
        '<tr>' +
          '<td>' + escapeHtml(rowNumber) + '</td>' +
          '<td>' + escapeHtml(person) + '</td>' +
          '<td>' + escapeHtml(eventTime) + '</td>' +
          '<td>' + escapeHtml(direction) + '</td>' +
          '<td>' + escapeHtml(deviceUid) + '</td>' +
          '<td>' + escapeHtml(vendor) + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  function renderCsvResult(result, summaryText) {
    byId('csvSummary').textContent = summaryText;
    renderMetrics(result);
    renderErrors(result);
    renderSamples(result);
  }

  function getCsvHeaders() {
    const headers = {};
    const vendor = String(byId('csvVendor').value || '').trim();
    const delimiter = String(byId('csvDelimiter').value || '').trim();
    if (vendor) {
      headers['x-vendor'] = vendor;
    }
    if (delimiter) {
      headers['x-csv-delimiter'] = delimiter;
    }
    return headers;
  }

  function downloadTextFile(text, fileName, contentType) {
    const blob = new Blob([text], { type: contentType || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function handlePreview() {
    const csvText = byId('csvText').value || '';
    if (!csvText.trim()) {
      throw new Error('Load a CSV file first.');
    }
    const ctx = getContext();
    const result = await requestApi({
      method: 'POST',
      path: '/api/device-events/import/preview',
      query: { company_id: ctx.companyId },
      headers: getCsvHeaders(),
      body: csvText
    });
    state.previewReady = true;
    byId('btnCommit').disabled = false;
    renderCsvResult(
      result.data,
      'Preview ready: valid=' + (result.data.valid_rows || 0) + ' invalid=' + (result.data.invalid_rows || 0)
    );
  }

  async function handleCommit() {
    const csvText = byId('csvText').value || '';
    if (!csvText.trim()) {
      throw new Error('Load a CSV file first.');
    }
    const ctx = getContext();
    const result = await requestApi({
      method: 'POST',
      path: '/api/device-events/import/commit',
      query: { company_id: ctx.companyId },
      headers: getCsvHeaders(),
      body: csvText
    });
    renderCsvResult(
      result.data,
      'Commit complete: inserted=' + (result.data.inserted_rows || 0) +
      ' skipped=' + (result.data.skipped_rows || 0) +
      ' failed=' + (result.data.failed_rows || 0) +
      ' warnings=' + (Array.isArray(result.data.errors) ? result.data.errors.length : 0)
    );
  }

  async function handleExportErrors() {
    const csvText = byId('csvText').value || '';
    if (!csvText.trim()) {
      throw new Error('Load a CSV file first.');
    }
    const ctx = getContext();
    const result = await requestApi({
      method: 'POST',
      path: '/api/device-events/import/preview/export-errors.csv',
      query: { company_id: ctx.companyId },
      headers: getCsvHeaders(),
      body: csvText
    });

    if (typeof result.data === 'string') {
      downloadTextFile(result.data, 'device-events-preview-errors.csv', 'text/csv;charset=utf-8');
      return;
    }
    throw new Error('Unexpected export response format.');
  }

  function normalizeAttendanceRows(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload && Array.isArray(payload.value)) {
      return payload.value;
    }
    if (payload && typeof payload === 'object') {
      return [payload];
    }
    return [];
  }

  function getAttendanceStatus(row) {
    if (row && row.effective && row.effective.status) {
      return row.effective.status;
    }
    return row && row.status ? row.status : '-';
  }

  function getAttendanceLateMinutes(row) {
    if (row && row.late_minutes !== undefined && row.late_minutes !== null) {
      return row.late_minutes;
    }
    if (row && row.effective && row.effective.metrics && row.effective.metrics.late_minutes !== undefined && row.effective.metrics.late_minutes !== null) {
      return row.effective.metrics.late_minutes;
    }
    return '-';
  }

  function getAttendanceSource(row) {
    if (row && row.source) {
      return row.source;
    }
    if (row && row.effective && row.effective.source) {
      return row.effective.source;
    }
    return '-';
  }

  function renderAttendanceRows(rows) {
    const body = byId('attendanceBody');
    if (!Array.isArray(rows) || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="7" class="muted">No rows</td></tr>';
      return;
    }

    body.innerHTML = rows.slice(0, 200).map(row => {
      const workDate = row && (row.work_date || row.date || row._request_date || '-');
      const person = row && (row.person_id || row.employee_code || row.employee || '-');
      const status = getAttendanceStatus(row);
      const firstIn = row && row.first_in ? row.first_in : '-';
      const lastOut = row && row.last_out ? row.last_out : '-';
      const lateMinutes = getAttendanceLateMinutes(row);
      const source = getAttendanceSource(row);

      return (
        '<tr>' +
          '<td>' + escapeHtml(workDate) + '</td>' +
          '<td>' + escapeHtml(person) + '</td>' +
          '<td>' + escapeHtml(status) + '</td>' +
          '<td>' + escapeHtml(firstIn) + '</td>' +
          '<td>' + escapeHtml(lastOut) + '</td>' +
          '<td>' + escapeHtml(lateMinutes) + '</td>' +
          '<td>' + escapeHtml(source) + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  async function loadAttendanceViewer() {
    const ctx = getContext();
    const dateFrom = byId('attendanceDateFrom').value;
    const dateTo = byId('attendanceDateTo').value;
    const personId = String(byId('attendancePersonId').value || '').trim();
    const dates = buildIsoDateRange(dateFrom, dateTo);

    const rows = [];
    for (const date of dates) {
      const result = await requestApi({
        method: 'GET',
        path: '/api/attendance',
        query: {
          company_id: ctx.companyId,
          date,
          person_id: personId || undefined
        }
      });
      const dayRows = normalizeAttendanceRows(result.data).map(row => (
        Object.assign({ _request_date: date }, row)
      ));
      rows.push(...dayRows);
    }

    byId('attendanceSummary').textContent = (
      'Loaded ' + rows.length + ' row(s) across ' + dates.length + ' day(s).'
    );
    renderAttendanceRows(rows);
  }

  function normalizeEmployeesRows(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload && Array.isArray(payload.value)) {
      return payload.value;
    }
    if (payload && typeof payload === 'object') {
      return [payload];
    }
    return [];
  }

  function renderEmployeesRows(rows) {
    const body = byId('employeesBody');
    if (!Array.isArray(rows) || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="muted">No rows</td></tr>';
      return;
    }

    body.innerHTML = rows.slice(0, 200).map(row => {
      const metaText = row && row.metadata ? toJson(row.metadata) : '{}';
      const updated = row && (row.updated_at || row.created_at) ? (row.updated_at || row.created_at) : '-';
      return (
        '<tr>' +
          '<td>' + escapeHtml(row && row.person_id ? row.person_id : '-') + '</td>' +
          '<td>' + escapeHtml(row && row.employee_code ? row.employee_code : '-') + '</td>' +
          '<td>' + escapeHtml(row && row.full_name ? row.full_name : '-') + '</td>' +
          '<td>' + escapeHtml(row && row.active !== undefined ? String(row.active) : '-') + '</td>' +
          '<td>' + escapeHtml(updated) + '</td>' +
          '<td><details><summary>view</summary><pre>' + escapeHtml(metaText) + '</pre></details></td>' +
        '</tr>'
      );
    }).join('');
  }

  function parseEmployeesMetadata() {
    const raw = String(byId('employeesMetadata').value || '').trim() || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error('Employees metadata must be valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Employees metadata must be a JSON object.');
    }
    return parsed;
  }

  async function upsertEmployee() {
    const ctx = getContext();
    const personId = String(byId('employeesPersonId').value || '').trim();
    if (!personId) {
      throw new Error('person_id is required for employees upsert.');
    }

    const fullName = String(byId('employeesFullName').value || '').trim();
    const payload = {
      metadata: parseEmployeesMetadata()
    };
    if (fullName) {
      payload.full_name = fullName;
    }

    const result = await requestApi({
      method: 'PUT',
      path: '/api/employees-registry/' + encodeURIComponent(personId),
      query: { company_id: ctx.companyId },
      body: payload
    });

    const rows = normalizeEmployeesRows(result.data);
    renderEmployeesRows(rows);
    byId('employeesSummary').textContent = 'Upserted employee: person_id=' + personId;
  }

  async function getEmployeeByPersonId() {
    const ctx = getContext();
    const personId = String(byId('employeesPersonId').value || '').trim();
    if (!personId) {
      throw new Error('person_id is required for employees GET.');
    }

    const result = await requestApi({
      method: 'GET',
      path: '/api/employees-registry/' + encodeURIComponent(personId),
      query: { company_id: ctx.companyId }
    });

    const rows = normalizeEmployeesRows(result.data);
    renderEmployeesRows(rows);
    byId('employeesSummary').textContent = 'Fetched employee: person_id=' + personId;
  }

  async function listEmployees() {
    const ctx = getContext();
    const personId = String(byId('employeesPersonId').value || '').trim();
    const result = await requestApi({
      method: 'GET',
      path: '/api/employees-registry',
      query: {
        company_id: ctx.companyId,
        person_id: personId || undefined,
        limit: byId('employeesLimit').value,
        offset: byId('employeesOffset').value
      }
    });

    const rows = normalizeEmployeesRows(result.data);
    renderEmployeesRows(rows);
    byId('employeesSummary').textContent = 'Loaded ' + rows.length + ' employee row(s).';
  }

  function renderDeviceRows(rows) {
    const body = byId('devicesBody');
    if (!Array.isArray(rows) || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="muted">No rows</td></tr>';
      return;
    }
    body.innerHTML = rows.slice(0, 100).map(row => {
      const metaText = row && row.metadata ? toJson(row.metadata) : '{}';
      const updated = row.updated_at || row.created_at || '-';
      return (
        '<tr>' +
          '<td>' + escapeHtml(row.device_uid || '-') + '</td>' +
          '<td>' + escapeHtml(row.provider || '-') + '</td>' +
          '<td>' + escapeHtml(row.device_name || '-') + '</td>' +
          '<td>' + escapeHtml(row.active === undefined ? '-' : String(row.active)) + '</td>' +
          '<td>' + escapeHtml(updated) + '</td>' +
          '<td><details><summary>view</summary><pre>' + escapeHtml(metaText) + '</pre></details></td>' +
        '</tr>'
      );
    }).join('');
  }

  async function loadDevices() {
    const ctx = getContext();
    const result = await requestApi({
      method: 'GET',
      path: '/api/devices',
      query: {
        company_id: ctx.companyId,
        provider: byId('devicesProvider').value,
        device_uid: byId('devicesUid').value,
        limit: byId('devicesLimit').value,
        offset: byId('devicesOffset').value
      }
    });

    const rows = Array.isArray(result.data.value)
      ? result.data.value
      : Array.isArray(result.data)
        ? result.data
        : [];
    renderDeviceRows(rows);
  }

  async function upsertDevice() {
    const ctx = getContext();
    const deviceUid = String(byId('upsertUid').value || '').trim();
    if (!deviceUid) {
      throw new Error('device_uid is required.');
    }

    let metadata = {};
    const metadataRaw = String(byId('upsertMetadata').value || '').trim() || '{}';
    try {
      metadata = JSON.parse(metadataRaw);
    } catch (err) {
      throw new Error('Metadata must be valid JSON.');
    }

    const payload = {
      active: Boolean(byId('upsertActive').checked),
      metadata
    };
    const provider = String(byId('upsertProvider').value || '').trim();
    const deviceName = String(byId('upsertName').value || '').trim();
    if (provider) {
      payload.provider = provider;
    }
    if (deviceName) {
      payload.device_name = deviceName;
    }

    await requestApi({
      method: 'PUT',
      path: '/api/devices/' + encodeURIComponent(deviceUid),
      query: { company_id: ctx.companyId },
      body: payload
    });

    await loadDevices();
  }

  function normalizeListRows(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload && Array.isArray(payload.value)) {
      return payload.value;
    }
    return [];
  }

  function renderOpsAgents(rows) {
    const body = byId('opsAgentsBody');
    if (!Array.isArray(rows) || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="muted">No rows</td></tr>';
      return;
    }
    body.innerHTML = rows.slice(0, 200).map(row => (
      '<tr>' +
        '<td>' + escapeHtml(row.id || '-') + '</td>' +
        '<td>' + escapeHtml(row.agent_name || '-') + '</td>' +
        '<td>' + escapeHtml(row.status || '-') + '</td>' +
        '<td>' + escapeHtml(row.last_seen_at || '-') + '</td>' +
        '<td>' + escapeHtml(row.last_heartbeat_at || '-') + '</td>' +
        '<td>' + escapeHtml(row.created_at || '-') + '</td>' +
      '</tr>'
    )).join('');
  }

  async function loadOpsAgents() {
    const ctx = getContext();
    const result = await requestApi({
      method: 'GET',
      path: '/api/agent-admin/agents',
      query: {
        company_id: ctx.companyId,
        status: byId('opsAgentsStatus').value,
        seen_since: byId('opsAgentsSeenSince').value,
        limit: byId('opsAgentsLimit').value,
        offset: byId('opsAgentsOffset').value
      }
    });
    renderOpsAgents(normalizeListRows(result.data));
  }

  function renderOpsDevices(rows) {
    const body = byId('opsDevicesBody');
    if (!Array.isArray(rows) || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="8" class="muted">No rows</td></tr>';
      return;
    }
    body.innerHTML = rows.slice(0, 200).map(row => (
      '<tr>' +
        '<td>' + escapeHtml(row.device_uid || '-') + '</td>' +
        '<td>' + escapeHtml(row.managed_status || '-') + '</td>' +
        '<td>' + escapeHtml(row.manageability_status || '-') + '</td>' +
        '<td>' + escapeHtml(row.manageability_reason || '-') + '</td>' +
        '<td>' + escapeHtml(row.remediation_manual_status || '-') + '</td>' +
        '<td>' + escapeHtml(row.remediation_manual_owner || '-') + '</td>' +
        '<td>' + escapeHtml(row.manageability_last_proven_at || '-') + '</td>' +
        '<td>' + escapeHtml(row.updated_at || '-') + '</td>' +
      '</tr>'
    )).join('');
  }

  async function loadOpsDevices() {
    const ctx = getContext();
    const result = await requestApi({
      method: 'GET',
      path: '/api/devices',
      query: {
        company_id: ctx.companyId,
        device_uid: byId('opsDevicesUid').value,
        managed_status: byId('opsDevicesManagedStatus').value,
        manageability_status: byId('opsDevicesManageabilityStatus').value,
        remediation_manual_status: byId('opsDevicesRemediationStatus').value,
        limit: byId('opsDevicesLimit').value,
        offset: byId('opsDevicesOffset').value
      }
    });
    renderOpsDevices(normalizeListRows(result.data));
  }

  function renderOpsCommands(rows) {
    const body = byId('opsCommandsBody');
    if (!Array.isArray(rows) || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="9" class="muted">No rows</td></tr>';
      return;
    }
    body.innerHTML = rows.slice(0, 200).map(row => (
      '<tr>' +
        '<td>' + escapeHtml(row.id || '-') + '</td>' +
        '<td>' + escapeHtml(row.status || '-') + '</td>' +
        '<td>' + escapeHtml(row.command_type || '-') + '</td>' +
        '<td>' + escapeHtml(row.agent_id || '-') + '</td>' +
        '<td>' + escapeHtml((row.command_payload && row.command_payload.device_uid) || '-') + '</td>' +
        '<td>' + escapeHtml(row.sent_at || '-') + '</td>' +
        '<td>' + escapeHtml(row.acknowledged_at || '-') + '</td>' +
        '<td>' + escapeHtml(row.failure_reason || '-') + '</td>' +
        '<td>' + escapeHtml(row.created_at || '-') + '</td>' +
      '</tr>'
    )).join('');
  }

  async function loadOpsCommands() {
    const ctx = getContext();
    const result = await requestApi({
      method: 'GET',
      path: '/api/agent-admin/commands',
      query: {
        company_id: ctx.companyId,
        agent_id: byId('opsCommandsAgentId').value,
        device_uid: byId('opsCommandsDeviceUid').value,
        status: byId('opsCommandsStatus').value,
        created_from: byId('opsCommandsCreatedFrom').value,
        created_to: byId('opsCommandsCreatedTo').value,
        limit: byId('opsCommandsLimit').value
      }
    });
    renderOpsCommands(normalizeListRows(result.data));
  }

  function renderOpsSyncStates(rows) {
    const body = byId('opsSyncBody');
    if (!Array.isArray(rows) || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="8" class="muted">No rows</td></tr>';
      return;
    }
    body.innerHTML = rows.slice(0, 200).map(row => (
      '<tr>' +
        '<td>' + escapeHtml(row.agent_id || '-') + '</td>' +
        '<td>' + escapeHtml(row.device_uid || '-') + '</td>' +
        '<td>' + escapeHtml(row.status || '-') + '</td>' +
        '<td>' + escapeHtml(row.cursor_event_time_utc || '-') + '</td>' +
        '<td>' + escapeHtml(row.last_sync_started_at || '-') + '</td>' +
        '<td>' + escapeHtml(row.last_sync_completed_at || '-') + '</td>' +
        '<td>' + escapeHtml(row.failure_reason || '-') + '</td>' +
        '<td>' + escapeHtml(row.updated_at || '-') + '</td>' +
      '</tr>'
    )).join('');
  }

  async function loadOpsSyncStates() {
    const ctx = getContext();
    const result = await requestApi({
      method: 'GET',
      path: '/api/agent-admin/device-sync-states',
      query: {
        company_id: ctx.companyId,
        agent_id: byId('opsSyncAgentId').value,
        device_uid: byId('opsSyncDeviceUid').value,
        limit: byId('opsSyncLimit').value,
        offset: byId('opsSyncOffset').value
      }
    });
    renderOpsSyncStates(normalizeListRows(result.data));
  }

  function formatRejectionSamples(samples) {
    if (!Array.isArray(samples) || samples.length === 0) {
      return '-';
    }
    return samples.map(sample => {
      const code = sample && sample.code ? sample.code : 'unknown';
      const person = sample && sample.device_person_id ? sample.device_person_id : '-';
      const time = sample && sample.event_time_utc ? sample.event_time_utc : '-';
      return code + ':' + person + '@' + time;
    }).join('\n');
  }

  function renderOpsBatches(rows) {
    const body = byId('opsBatchesBody');
    if (!Array.isArray(rows) || rows.length === 0) {
      body.innerHTML = '<tr><td colspan="8" class="muted">No rows</td></tr>';
      return;
    }
    body.innerHTML = rows.slice(0, 200).map(row => (
      '<tr>' +
        '<td>' + escapeHtml(row.status || '-') + '</td>' +
        '<td>' + escapeHtml(row.failure_reason || '-') + '</td>' +
        '<td>' + escapeHtml(row.inserted_count !== undefined ? row.inserted_count : '-') + '</td>' +
        '<td>' + escapeHtml(row.deduped_count !== undefined ? row.deduped_count : '-') + '</td>' +
        '<td>' + escapeHtml(row.rejected_count !== undefined ? row.rejected_count : '-') + '</td>' +
        '<td>' + escapeHtml(row.command_id || '-') + '</td>' +
        '<td>' + escapeHtml(row.pull_completed_at || '-') + '</td>' +
        '<td><pre>' + escapeHtml(formatRejectionSamples(row.rejection_samples)) + '</pre></td>' +
      '</tr>'
    )).join('');
  }

  async function loadOpsBatches() {
    const ctx = getContext();
    const result = await requestApi({
      method: 'GET',
      path: '/api/agent-admin/device-event-batches',
      query: {
        company_id: ctx.companyId,
        agent_id: byId('opsBatchesAgentId').value,
        device_uid: byId('opsBatchesDeviceUid').value,
        status: byId('opsBatchesStatus').value,
        created_from: byId('opsBatchesCreatedFrom').value,
        created_to: byId('opsBatchesCreatedTo').value,
        limit: byId('opsBatchesLimit').value
      }
    });
    renderOpsBatches(normalizeListRows(result.data));
  }

  function handleError(err) {
    const payload = err && err.payload ? err.payload : { error: err.message };
    if (isErrorEnvelope(payload)) {
      renderErrorEnvelope(payload);
    } else {
      clearErrorEnvelope();
    }
    const text = err && err.status
      ? ('Request failed: HTTP ' + err.status)
      : ('Request failed: ' + (err.message || 'unknown error'));
    setRequestState('err', text, payload);
    return false;
  }

  function bindEvents() {
    byId('tabCsv').addEventListener('click', function () {
      switchPage('csv');
    });
    byId('tabAttendance').addEventListener('click', function () {
      switchPage('attendance');
    });
    byId('tabEmployees').addEventListener('click', function () {
      switchPage('employees');
    });
    byId('tabDevices').addEventListener('click', function () {
      switchPage('devices');
    });
    byId('tabBridgeOps').addEventListener('click', function () {
      switchPage('bridgeOps');
    });

    [
      'baseUrl',
      'companyId',
      'apiKey',
      'csvVendor',
      'csvDelimiter',
      'attendanceDateFrom',
      'attendanceDateTo',
      'attendancePersonId',
      'employeesPersonId'
    ].forEach(id => {
      byId(id).addEventListener('change', persistInputs);
      byId(id).addEventListener('blur', persistInputs);
    });

    byId('csvFile').addEventListener('change', function (event) {
      const file = event.target.files && event.target.files[0];
      if (!file) {
        return;
      }
      const reader = new FileReader();
      reader.onload = function () {
        byId('csvText').value = String(reader.result || '');
        state.previewReady = false;
        byId('btnCommit').disabled = true;
      };
      reader.readAsText(file);
    });

    byId('btnPreview').addEventListener('click', async function () {
      persistInputs();
      setCsvButtonsDisabled(true);
      try {
        await handlePreview();
      } catch (err) {
        state.previewReady = false;
        byId('btnCommit').disabled = true;
        handleError(err);
      } finally {
        setCsvButtonsDisabled(false);
      }
    });

    byId('btnCommit').addEventListener('click', async function () {
      persistInputs();
      setCsvButtonsDisabled(true);
      try {
        await handleCommit();
      } catch (err) {
        handleError(err);
      } finally {
        setCsvButtonsDisabled(false);
      }
    });

    byId('btnExportErrors').addEventListener('click', async function () {
      persistInputs();
      setCsvButtonsDisabled(true);
      try {
        await handleExportErrors();
      } catch (err) {
        handleError(err);
      } finally {
        setCsvButtonsDisabled(false);
      }
    });

    byId('btnLoadDevices').addEventListener('click', async function () {
      persistInputs();
      try {
        await loadDevices();
      } catch (err) {
        handleError(err);
      }
    });

    byId('btnAttendanceLoad').addEventListener('click', async function () {
      persistInputs();
      try {
        await loadAttendanceViewer();
      } catch (err) {
        handleError(err);
      }
    });

    byId('btnEmployeeUpsert').addEventListener('click', async function () {
      persistInputs();
      try {
        await upsertEmployee();
      } catch (err) {
        handleError(err);
      }
    });

    byId('btnEmployeeGet').addEventListener('click', async function () {
      persistInputs();
      try {
        await getEmployeeByPersonId();
      } catch (err) {
        handleError(err);
      }
    });

    byId('btnEmployeeList').addEventListener('click', async function () {
      persistInputs();
      try {
        await listEmployees();
      } catch (err) {
        handleError(err);
      }
    });

    byId('btnUpsertDevice').addEventListener('click', async function () {
      persistInputs();
      try {
        await upsertDevice();
      } catch (err) {
        handleError(err);
      }
    });

    byId('btnOpsLoadAgents').addEventListener('click', async function () {
      persistInputs();
      try {
        await loadOpsAgents();
      } catch (err) {
        handleError(err);
      }
    });

    byId('btnOpsLoadDevices').addEventListener('click', async function () {
      persistInputs();
      try {
        await loadOpsDevices();
      } catch (err) {
        handleError(err);
      }
    });

    byId('btnOpsLoadCommands').addEventListener('click', async function () {
      persistInputs();
      try {
        await loadOpsCommands();
      } catch (err) {
        handleError(err);
      }
    });

    byId('btnOpsLoadSyncStates').addEventListener('click', async function () {
      persistInputs();
      try {
        await loadOpsSyncStates();
      } catch (err) {
        handleError(err);
      }
    });

    byId('btnOpsLoadBatches').addEventListener('click', async function () {
      persistInputs();
      try {
        await loadOpsBatches();
      } catch (err) {
        handleError(err);
      }
    });
  }

  function init() {
    restoreInputs();
    bindEvents();
    switchPage('csv');
    clearErrorEnvelope();
    setRequestState('info', 'Ready.', null);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
