function qs(id) {
  return document.getElementById(id);
}

function toReasonText(status, reasonCode) {
  if (reasonCode === undefined || reasonCode === null || reasonCode === '') {
    return 'Cached result';
  }

  if (status === 'NON_WORKING_DAY') return 'Non-working day';
  if (status === 'ON_LEAVE') return 'On leave';

  const map = {
    NO_EVENTS: 'No punch events',
    ON_TIME: 'Arrived on time',
    LATE_ARRIVAL: 'Arrived late',
    WORK_MINUTES_OK: 'Minimum work time met',
    FALLBACK: 'Fallback rule',
    INVALID_CONTEXT: 'Invalid configuration'
  };

  return map[reasonCode] || reasonCode;
}

function fmt(v) {
  if (v === null || v === undefined || v === '') return '-';
  return String(v);
}

function setStatus(msg) {
  qs('status').textContent = msg;
}

function setRaw(obj) {
  qs('raw').textContent = JSON.stringify(obj, null, 2);
}

function setTable(rows) {
  const tbody = qs('tbody');
  tbody.innerHTML = '';

  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="muted">No rows</td></tr>';
    return;
  }

  for (const r of rows) {
    const reason = toReasonText(r.status, r.reason_code);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmt(r.employee)}</td>
      <td>${fmt(r.status)}</td>
      <td>${fmt(reason)}</td>
      <td>${fmt(r.first_in)}</td>
      <td>${fmt(r.last_out)}</td>
      <td>${fmt(r.worked_minutes)}</td>
      <td>${fmt(r.break_minutes)}</td>
      <td>${fmt(r.net_worked_minutes)}</td>
      <td>${fmt(r.late_minutes)}</td>
      <td>${fmt(r.source)}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadAttendance(date) {
  const url = '/api/attendance?date=' + encodeURIComponent(date);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function todayISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}

window.addEventListener('DOMContentLoaded', () => {
  qs('date').value = todayISO();

  qs('btnLoad').addEventListener('click', async () => {
    const date = qs('date').value;
    if (!date) return;

    setStatus('Loading...');
    try {
      const rows = await loadAttendance(date);
      setTable(rows);
      setRaw(rows);
      setStatus('OK');
    } catch (e) {
      console.error(e);
      setStatus('Error: ' + e.message);
      setTable([]);
      setRaw({ error: e.message });
    }
  });
});
