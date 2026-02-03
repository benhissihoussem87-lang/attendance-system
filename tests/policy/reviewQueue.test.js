const http = require('http');
const https = require('https');

const baseUrl = process.env.BASE_URL;
const allowTestEndpoints = process.env.ALLOW_TEST_ENDPOINTS === 'true';
const shouldRun = Boolean(baseUrl) && allowTestEndpoints;
const describeOrSkip = shouldRun ? describe : describe.skip;

function requestJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        if (data) {
          try {
            json = JSON.parse(data);
          } catch (err) {
            json = null;
          }
        }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function unwrapValue(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return value.value;
  }
  return value;
}

describeOrSkip('review queue', () => {
  const date = process.env.ATTENDANCE_DATE || '2026-01-09';
  const personId = process.env.ATTENDANCE_PERSON_ID || 'p1';

  test('needs review day appears in review queue', async () => {
    await requestJson('POST', '/api/ops/test/reset', {
      company_id: 'DEFAULT',
      company_timezone: 'Africa/Tunis',
      night_shift_enabled: true,
      day_start_time: '04:00',
      person_id: personId,
      date,
      events: [
        { event_time_utc: `${date}T06:00:00.000Z`, direction: 'IN', device_uid: '' },
        { event_time_utc: `${date}T16:00:00.000Z`, direction: 'OUT', device_uid: '' }
      ]
    });

    const attendanceRes = await requestJson('GET', `/api/attendance?date=${date}&person_id=${personId}`);
    const attendanceBody = unwrapValue(attendanceRes.body);
    const attendanceRecord = Array.isArray(attendanceBody) ? attendanceBody[0] : attendanceBody;

    await requestJson(
      'POST',
      `/api/attendance/${attendanceRecord.attendance_day_id}/resolutions`,
      {
        company_id: 'DEFAULT',
        decided_by: 'tester',
        effective_status: 'NEEDS_REVIEW',
        reason_code: 'MANUAL_REVIEW'
      }
    );

    const queueRes = await requestJson(
      'GET',
      `/api/attendance/review-queue?date_from=${date}&date_to=${date}&company_id=DEFAULT`
    );

    expect(queueRes.status).toBe(200);
    const entry = queueRes.body.find(item => item.attendance_day_id === attendanceRecord.attendance_day_id);
    expect(entry).toBeTruthy();
    expect(entry.effective_status).toBe('NEEDS_REVIEW');
  });
});
