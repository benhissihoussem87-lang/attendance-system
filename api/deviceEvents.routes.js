const express = require('express');
const router = express.Router();

const db = require('../db');
const { invalidateAttendanceCache } = require('../services/cacheInvalidation');
const { validateDeviceEventsCsv } = require('../services/deviceEventsCsvValidator');
const { mapAndValidateEvents } = require('../services/deviceEventIngestor');
const { COMPANY_TIMEZONE } = require('../config/timezone');
const {
  interpretEventTime,
  isTimeInterpretationEnabled
} = require('../services/timeInterpreter');
const {
  SYSTEM_VERSION,
  CSV_IMPORT_VERSION,
  CSV_CONTRACT
} = require('../contracts/systemContracts');

function getDelimiter(req) {
  const raw =
    (req.query && req.query.delimiter) ||
    req.get('x-csv-delimiter');

  if (!raw) {
    return undefined;
  }

  const value = String(raw).toLowerCase();
  if (value === 'tab' || value === '\\t') {
    return '\t';
  }
  if (value === ',' || value === ';' || value === '\t') {
    return value;
  }
  return undefined;
}

/**
 * POST /api/device-events
 * Insert single device event (JSON)
 */
router.post('/', async (req, res) => {
  try {
    const {
      person_id,
      event_time_utc,
      direction,
      vendor = null,
      device_uid = null,
      raw_payload = null
    } = req.body;
    let parsedPayload = raw_payload;

    if (!person_id || !event_time_utc || !direction) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!['IN', 'OUT'].includes(direction)) {
      return res.status(400).json({ error: 'Invalid direction' });
    }

    if (typeof raw_payload === 'string') {
      try {
        parsedPayload = JSON.parse(raw_payload);
      } catch (err) {
        return res.status(400).json({ error: 'Invalid raw_payload JSON' });
      }
    }

    await db.query(
      `
      INSERT INTO device_events
        (person_id, event_time_utc, direction, vendor, device_uid, raw_payload)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      `,
      [
        person_id,
        event_time_utc,
        direction,
        vendor,
        device_uid,
        parsedPayload
      ]
    );

    await invalidateAttendanceCache(db, person_id, event_time_utc);

    res.status(201).json({ status: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'device event insert failed' });
  }
});

/**
 * POST /api/device-events/import/preview
 * CSV preview ONLY (no DB writes)
 * Accepts raw text/plain CSV
 */
router.post(
  '/import/preview',
  express.raw({ type: '*/*', limit: '10mb' }),
  (req, res) => {
    try {
      const csvText =
        req.body instanceof Buffer
          ? req.body.toString('utf8')
          : '';

      if (!csvText.trim()) {
        return res.status(400).json({ error: 'CSV content is required' });
      }

      const options = {};
      const delimiter = getDelimiter(req);
      if (delimiter) {
        options.delimiter = delimiter;
      }

      const validation = validateDeviceEventsCsv(csvText, options);
      const timeInterpretationEnabled = isTimeInterpretationEnabled();

      const sample_valid_rows = validation.rows
        .filter(row => row.valid)
        .slice(0, 10)
        .map(row => {
          if (!timeInterpretationEnabled) {
            return {
              row_number: row.row_number,
              data: row.data
            };
          }

          const interpreted = interpretEventTime({
            event_time_raw: row.data.event_time,
            company_timezone: COMPANY_TIMEZONE
          });

          const data = {
            ...row.data,
            event_time: interpreted.event_time_utc
          };
          const previewPayload =
            data.raw_payload && typeof data.raw_payload === 'object'
              ? { ...data.raw_payload }
              : data.raw_payload !== undefined
                ? { original_raw_payload: data.raw_payload }
                : {};
          previewPayload.preview_time_interpretation = interpreted.time_audit;
          data.raw_payload = previewPayload;

          return {
            row_number: row.row_number,
            data
          };
        });

      res.json({
        system_version: SYSTEM_VERSION,
        contract: CSV_CONTRACT,
        import_version: CSV_IMPORT_VERSION,
        total_rows: validation.total_rows,
        valid_rows: validation.valid_rows,
        invalid_rows: validation.invalid_rows,
        errors: validation.errors,
        sample_valid_rows
      });
    } catch (err) {
      console.error(err);
      if (err && err.code === 'TIME_INTERPRETATION_FAILED') {
        return res.status(400).json({
          error: 'Time interpretation failed',
          details: err.message || 'Invalid event_time'
        });
      }
      res.status(500).json({ error: 'preview failed' });
    }
  }
);

/**
 * POST /api/device-events/import/commit
 * CSV commit (DB writes)
 * Accepts raw text/plain CSV
 */
router.post(
  '/import/commit',
  express.raw({ type: '*/*', limit: '10mb' }),
  async (req, res) => {
    const csvText =
      req.body instanceof Buffer
        ? req.body.toString('utf8')
        : '';

    if (!csvText.trim()) {
      return res.status(400).json({ error: 'CSV content is required' });
    }

    const options = {};
    const delimiter = getDelimiter(req);
    if (delimiter) {
      options.delimiter = delimiter;
    }
    const validationResult = validateDeviceEventsCsv(csvText, options);
    const missingRequired = validationResult.errors.some(
      err => err.code === 'MISSING_REQUIRED_COLUMN'
    );

    if (missingRequired) {
      return res.status(400).json(validationResult);
    }

    const errors = validationResult.errors.slice(0, 200);
    let inserted_rows = 0;
    let skipped_rows = 0;
    let failed_rows = validationResult.invalid_rows;
    const timeInterpretationEnabled = isTimeInterpretationEnabled();
    const first3Inserted = [];
    const last3Inserted = [];

    for (const row of validationResult.rows) {
      if (!row.valid) {
        continue;
      }

      const data = row.data || {};
      let eventTimeUtc = data.event_time;
      let timeAudit = null;
      if (timeInterpretationEnabled) {
        try {
          const interpreted = interpretEventTime({
            event_time_raw: data.event_time,
            company_timezone: COMPANY_TIMEZONE
          });
          eventTimeUtc = interpreted.event_time_utc;
          timeAudit = interpreted.time_audit;
        } catch (err) {
          if (errors.length < 200) {
            errors.push({
              row_number: row.row_number,
              code: 'TIME_INTERPRETATION_FAILED',
              message: err.message || 'Time interpretation failed'
            });
          }
          failed_rows += 1;
          continue;
        }
      }
      const rawPayload = {
        source: 'csv_import'
      };
      if (data.card_number !== undefined) {
        rawPayload.card_number = data.card_number;
      }
      if (data.employee_code !== undefined) {
        rawPayload.employee_code = data.employee_code;
      }
      if (data.vendor !== undefined) {
        rawPayload.vendor = data.vendor;
      }
      if (data.device_uid !== undefined) {
        rawPayload.device_uid = data.device_uid;
      }
      if (data.raw_payload !== undefined) {
        rawPayload.raw_payload = data.raw_payload;
      }
      if (timeInterpretationEnabled && timeAudit) {
        rawPayload.time_interpretation = timeAudit;
      }

      const ingestInput = {
        person_id: data.person_id,
        event_time_utc: eventTimeUtc,
        direction: data.direction,
        vendor: data.vendor || null,
        device_uid: data.device_uid ?? '',
        raw_payload: rawPayload
      };
      const ingestResult = mapAndValidateEvents({
        vendor: data.vendor || null,
        rows: [ingestInput],
        context: { vendor: data.vendor || null }
      });
      if (ingestResult.badRows.length > 0) {
        if (errors.length < 200) {
          const details = ingestResult.badRows[0].errors || [];
          const message = details.length > 0
            ? details.map(err => `${err.field}: ${err.message}`).join('; ')
            : 'Invalid device event';
          errors.push({
            row_number: row.row_number,
            code: 'INGEST_INVALID',
            message
          });
        }
        failed_rows += 1;
        continue;
      }
      const canonical = ingestResult.okRows[0];

      const values = [
        canonical.person_id,
        canonical.event_time_utc,
        canonical.direction,
        canonical.vendor,
        canonical.device_uid,
        canonical.raw_payload
      ];

      let result;
      try {
        result = await db.query(
          `
          INSERT INTO device_events
            (person_id, event_time_utc, direction, vendor, device_uid, raw_payload)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb)
          ON CONFLICT (person_id, event_time_utc, direction, device_uid) DO NOTHING
          RETURNING person_id, event_time_utc, direction, device_uid, vendor
          `,
          values
        );
      } catch (dbErr) {
        const details = [];
        if (dbErr && dbErr.code) {
          details.push(`code=${dbErr.code}`);
        }
        if (dbErr && dbErr.message) {
          const msg = String(dbErr.message);
          details.push(`message=${msg.slice(0, 200)}`);
        }
        if (errors.length < 200) {
          errors.push({
            row_number: row.row_number,
            code: 'DB_INSERT_FAILED',
            message: details.length > 0
              ? `Database insert failed (${details.join(', ')})`
              : 'Database insert failed'
          });
        }
        failed_rows += 1;
        continue;
      }

      if (result.rowCount === 1) {
        inserted_rows += 1;
        try {
          await invalidateAttendanceCache(db, canonical.person_id, canonical.event_time_utc);
        } catch (cacheErr) {
          if (errors.length < 200) {
            errors.push({
              row_number: row.row_number,
              code: 'CACHE_INVALIDATION_FAILED',
              message: 'Cache invalidation failed'
            });
          }
        }
        const returnedRow = result.rows[0] || {};
        const sampleItem = {
          row_number: row.row_number,
          person_id: returnedRow.person_id,
          event_time_utc: returnedRow.event_time_utc,
          direction: returnedRow.direction,
          device_uid: returnedRow.device_uid,
          vendor: returnedRow.vendor
        };
        if (first3Inserted.length < 3) {
          first3Inserted.push(sampleItem);
        }
        last3Inserted.push(sampleItem);
        if (last3Inserted.length > 3) {
          last3Inserted.shift();
        }
      } else {
        skipped_rows += 1;
      }
    }

    return res.json({
      system_version: SYSTEM_VERSION,
      contract: CSV_CONTRACT,
      import_version: CSV_IMPORT_VERSION,
      total_rows: validationResult.total_rows,
      valid_rows: validationResult.valid_rows,
      invalid_rows: validationResult.invalid_rows,
      inserted_rows,
      skipped_rows,
      failed_rows,
      errors,
      inserted_samples: {
        first3: first3Inserted,
        last3: last3Inserted
      }
    });
  }
);

module.exports = router;
