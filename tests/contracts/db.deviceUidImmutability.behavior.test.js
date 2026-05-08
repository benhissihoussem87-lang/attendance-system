const assert = require('assert');
const { Client } = require('pg');

async function run() {
  const client = new Client();
  await client.connect();

  const deviceUid = `zkteco:sn:IMMUTABLE-${Date.now()}`;
  const replacementUid = `${deviceUid}-MUTATED`;
  let rollbackNeeded = false;

  try {
    await client.query('BEGIN');
    rollbackNeeded = true;

    const companyRes = await client.query(`
      SELECT company_id
      FROM companies
      ORDER BY company_id ASC
      LIMIT 1
    `);
    const companyId = companyRes.rows[0] && companyRes.rows[0].company_id
      ? String(companyRes.rows[0].company_id)
      : '';
    if (!companyId) {
      await client.query('ROLLBACK');
      rollbackNeeded = false;
      console.log('SKIP: db device_uid immutability behavior (no companies rows)');
      return;
    }

    await client.query(
      `
      INSERT INTO devices (company_id, device_uid, provider)
      VALUES ($1, $2, $3)
      `,
      [companyId, deviceUid, 'zkteco']
    );

    let updateError = null;
    try {
      await client.query(
        `
        UPDATE devices
        SET device_uid = $1
        WHERE company_id = $2
          AND device_uid = $3
        `,
        [replacementUid, companyId, deviceUid]
      );
    } catch (err) {
      updateError = err;
    }

    assert.ok(updateError, 'device_uid update should be blocked by immutability trigger');
    const errorMessage = String(updateError && updateError.message ? updateError.message : '');
    assert.ok(
      errorMessage.toLowerCase().includes('immutable'),
      'immutability trigger error should explain immutable device_uid enforcement'
    );

    await client.query('ROLLBACK');
    rollbackNeeded = false;
    console.log('PASS: db device_uid immutability behavior');
  } finally {
    if (rollbackNeeded) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
