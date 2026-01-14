// DEPRECATED: Prefer api/deviceEvents.routes.js commit endpoint for CSV imports.
const { validateDeviceEventsCsv } = require('./deviceEventsCsvValidator');
const { invalidateAttendanceCache } = require('./cacheInvalidation');

async function importDeviceEventsCsv(db, csvText, options = {}) {
  const validation = validateDeviceEventsCsv(csvText, options);
  const missingRequired = validation.errors.some(
    error => error.code === 'MISSING_REQUIRED_COLUMN'
  );

  if (missingRequired) {
    return {
      total_rows: validation.total_rows,
      valid_rows: 0,
      inserted_rows: 0,
      failed_rows: 0,
      errors: validation.errors
    };
  }

  const errors = [...validation.errors];
  let inserted_rows = 0;
  let invalid_rows = validation.invalid_rows;
  let db_failed_rows = 0;

  for (const row of validation.rows) {
    if (!row.valid || !row.data) {
      continue;
    }

    const rawPayload = {
      source: 'csv_import'
    };
    if (row.data.card_number !== undefined) {
      rawPayload.card_number = row.data.card_number;
    }
    if (row.data.employee_code !== undefined) {
      rawPayload.employee_code = row.data.employee_code;
    }
    if (row.data.vendor !== undefined) {
      rawPayload.vendor = row.data.vendor;
    }
    if (row.data.device_uid !== undefined) {
      rawPayload.device_uid = row.data.device_uid;
    }
    if (row.data.raw_payload !== undefined) {
      rawPayload.raw_payload = row.data.raw_payload;
    }

    try {
      const companyId = row.data.company_id || 'DEFAULT';
      const result = await db.query(
        `
        INSERT INTO device_events
          (company_id, person_id, event_time_utc, direction, vendor, device_uid, raw_payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT ON CONSTRAINT device_events_dedup_company_uk DO NOTHING
        `,
        [
          companyId,
          row.data.person_id,
          row.data.event_time,
          row.data.direction,
          row.data.vendor ?? null,
          row.data.device_uid ?? null,
          rawPayload
        ]
      );

      if (result.rowCount === 1) {
        await invalidateAttendanceCache(db, row.data.person_id, row.data.event_time, {
          companyId
        });
        inserted_rows += 1;
      }
    } catch (err) {
      db_failed_rows += 1;
      errors.push({
        row_number: row.row_number,
        code: 'DB_INSERT_FAILED',
        message: err.message || 'Insert failed'
      });
    }
  }

  return {
    total_rows: validation.total_rows,
    valid_rows: validation.valid_rows,
    invalid_rows,
    db_failed_rows,
    inserted_rows,
    errors
  };
}

module.exports = { importDeviceEventsCsv };
