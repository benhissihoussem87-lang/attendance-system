import { request } from './apiClient.js';
import { state } from './state.js';
import { byId, esc, formatTime, rows, text } from './renderHelpers.js';
import { attendanceExplanationDisplayLabel, attendanceStatusDisplayLabel } from './policies.js';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function defaultStartDate() {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return date.toISOString().slice(0, 10);
}

function selectedSiteTimezone(row) {
  return text(row && row.timezone).trim() || 'UTC';
}

function siteOptionsHtml() {
  const options = ['<option value="">All product sites</option>'];
  state.sites.forEach(site => {
    options.push(`<option value="${esc(site.site_id)}">${esc(site.site_name || site.site_key || site.site_id)}</option>`);
  });
  return options.join('');
}

function employeeOptionsHtml() {
  const options = ['<option value="">All product employees</option>'];
  state.employees.forEach(employee => {
    options.push(`<option value="${esc(employee.person_id)}">${esc(employee.employee_code || employee.person_id)} - ${esc(employee.full_name || employee.employee_name || '')}</option>`);
  });
  return options.join('');
}

export function renderAttendanceFilters() {
  const startInput = byId('attendanceStartDate');
  const endInput = byId('attendanceEndDate');
  if (startInput && !startInput.value) startInput.value = defaultStartDate();
  if (endInput && !endInput.value) endInput.value = todayIso();

  const siteSelect = byId('attendanceSiteFilter');
  if (siteSelect) {
    const previous = siteSelect.value;
    siteSelect.innerHTML = siteOptionsHtml();
    siteSelect.value = previous;
  }

  const employeeSelect = byId('attendanceEmployeeFilter');
  if (employeeSelect) {
    const previous = employeeSelect.value;
    employeeSelect.innerHTML = employeeOptionsHtml();
    employeeSelect.value = previous;
  }
}

function statusLabel(row) {
  return attendanceStatusDisplayLabel(row.status);
}

function renderRows() {
  const body = byId('attendanceRows');
  if (!body) return;
  if (state.attendance.loading) {
    body.innerHTML = '<tr><td colspan="8">Loading attendance.</td></tr>';
    return;
  }
  if (state.attendance.error) {
    body.innerHTML = `<tr><td colspan="8">${esc(state.attendance.error)}</td></tr>`;
    return;
  }
  if (!state.attendance.rows.length) {
    body.innerHTML = '<tr><td colspan="8">No product attendance rows for the selected filters.</td></tr>';
    return;
  }
  body.innerHTML = state.attendance.rows.map(row => {
    const tz = selectedSiteTimezone(row);
    const rawExplanation = Array.isArray(row.explanation) ? row.explanation.join(' ') : text(row.status_basis);
    const explanation = attendanceExplanationDisplayLabel(rawExplanation);
    return `
      <tr>
        <td>${esc(row.local_date)}</td>
        <td>${esc(row.site_name || '-')}</td>
        <td>${esc(row.employee_code || '-')}</td>
        <td>${esc(row.employee_name || '-')}</td>
        <td>${esc(formatTime(row.first_punch_time, tz))}</td>
        <td>${esc(formatTime(row.last_punch_time, tz))}</td>
        <td>${esc(row.event_count)}</td>
        <td><strong>${esc(statusLabel(row))}</strong><br><small>${esc(explanation)}</small>${rawExplanation && rawExplanation !== explanation ? '<br><small>Details: ' + esc(rawExplanation) + '</small>' : ''}</td>
      </tr>
    `;
  }).join('');
}

function renderUnmapped() {
  const container = byId('attendanceUnmapped');
  if (!container) return;
  if (!state.attendance.unmappedDeviceUsers.length) {
    container.innerHTML = '<p>No unmapped product-device punches in this filter.</p>';
    return;
  }
  container.innerHTML = `
    <p>Unmapped device users were found. They are not counted as employee attendance rows.</p>
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Site</th>
          <th>Device</th>
          <th>Device user</th>
          <th>Events</th>
          <th>First punch</th>
          <th>Last punch</th>
        </tr>
      </thead>
      <tbody>
        ${state.attendance.unmappedDeviceUsers.map(row => {
          const tz = text(row.timezone).trim() || 'UTC';
          return `
            <tr>
              <td>${esc(row.local_date)}</td>
              <td>${esc(row.site_name || '-')}</td>
              <td>${esc(row.device_uid || '-')}</td>
              <td>${esc(row.device_user_id || '-')}</td>
              <td>${esc(row.event_count)}</td>
              <td>${esc(formatTime(row.first_punch_time, tz))}</td>
              <td>${esc(formatTime(row.last_punch_time, tz))}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function renderSummary() {
  const summary = byId('attendanceSummary');
  if (!summary) return;
  if (state.attendance.error) {
    summary.textContent = state.attendance.error;
    return;
  }
  const meta = state.attendance.meta || {};
  summary.textContent = `${state.attendance.rows.length} attendance rows, ${state.attendance.unmappedDeviceUsers.length} unmapped device-user groups. Source: ${meta.source || 'device_events'}. Validation users excluded by default.`;
}

export function renderAttendance() {
  renderAttendanceFilters();
  renderSummary();
  renderRows();
  renderUnmapped();
}

function attendanceQuery() {
  return {
    start_date: byId('attendanceStartDate') ? byId('attendanceStartDate').value : defaultStartDate(),
    end_date: byId('attendanceEndDate') ? byId('attendanceEndDate').value : todayIso(),
    site_id: byId('attendanceSiteFilter') ? byId('attendanceSiteFilter').value : '',
    person_id: byId('attendanceEmployeeFilter') ? byId('attendanceEmployeeFilter').value : ''
  };
}

export async function loadAttendance() {
  state.attendance.loading = true;
  state.attendance.error = '';
  renderAttendance();
  try {
    const data = await request('GET', '/api/attendance-v1/daily', undefined, attendanceQuery());
    state.attendance.rows = rows(data);
    state.attendance.unmappedDeviceUsers = Array.isArray(data && data.unmapped_device_users)
      ? data.unmapped_device_users
      : [];
    state.attendance.meta = data && data.meta ? data.meta : null;
  } catch (err) {
    if (err && err.sessionExpired) return;
    state.attendance.rows = [];
    state.attendance.unmappedDeviceUsers = [];
    state.attendance.meta = null;
    state.attendance.error = 'Attendance load failed: ' + (err && err.message ? err.message : 'unknown error');
  } finally {
    state.attendance.loading = false;
    renderAttendance();
  }
}

export function bindAttendance() {
  const refresh = byId('refreshAttendance');
  if (refresh) refresh.addEventListener('click', () => loadAttendance());
  ['attendanceStartDate', 'attendanceEndDate', 'attendanceSiteFilter', 'attendanceEmployeeFilter'].forEach(id => {
    const el = byId(id);
    if (el) el.addEventListener('change', () => loadAttendance());
  });
}
