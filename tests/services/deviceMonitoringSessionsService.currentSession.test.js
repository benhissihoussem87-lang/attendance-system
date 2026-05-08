const assert = require('assert');
const {
  getCurrentSessionForDevice
} = require('../../services/deviceMonitoringSessionsService');

async function run() {
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT \*/i.test(sql)) {
        return {
          rows: [{
            id: 'session-expired',
            company_id: 'DEFAULT',
            device_uid: 'zkteco:sn:BIND-QUEUE-c26a7486',
            status: 'expired',
            expires_at: expiredAt,
            metadata: { runtime_state: 'active' },
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString()
          }]
        };
      }
      return { rows: [] };
    }
  };

  const result = await getCurrentSessionForDevice(db, {
    companyId: 'DEFAULT',
    deviceUid: 'zkteco:sn:BIND-QUEUE-c26a7486'
  });

  assert.ifError(result.error);
  assert.strictEqual(result.value.id, 'session-expired');
  assert.strictEqual(result.value.status, 'expired');
  assert.strictEqual(result.value.active_lease, false);
  assert.ok(calls[0].sql.includes("status IN ('starting', 'active')"), 'stale sessions should be expired before read');
  assert.ok(calls[1].sql.includes('FROM device_monitoring_sessions'), 'current session should be read by device');

  console.log('device monitoring current session tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { run };
