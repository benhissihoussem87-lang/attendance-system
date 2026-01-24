const express = require('express');
const router = express.Router();

const db = require('../db');
const { invalidateAttendanceCache } = require('../services/cacheInvalidation');
const { parseDeviceEventsCsv } = require('../services/deviceEventsCsvValidator');
const { mapAndValidateEvents } = require('../services/deviceEventIngestor');
const { buildErrorIntelligence } = require('../services/csvErrorIntelligence');
const { buildErrorsCsv } = require('../services/csvErrorExport');
const { normalizeCanonicalEvent } = require('../contracts/deviceEventContract');
const { validateCanonicalEvent } = require('../services/validators/deviceEventValidator');
const { requireDeviceUid } = require('../services/validators/deviceIdentity');
const { COMPANY_TIMEZONE } = require('../config/timezone');
const {
  interpretEventTime,
  isTimeInterpretationEnabled
} = require('../services/timeInterpreter');
const { resolvePersonIdForIdentifier } = require('../services/identityResolver');
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

function getVendor(req) {
  const raw =
    (req.query && req.query.vendor) ||
    req.get('x-vendor');

  if (!raw) {
    return null;
  }

  return String(raw).trim().toLowerCase();
}

function resolveCompanyId(req, body) {
  const bodyId = body && typeof body.company_id === 'string' ? body.company_id : null;
  const queryId = req.query && typeof req.query.company_id === 'string' ? req.query.company_id : null;
  const headerId = typeof req.get('x-company-id') === 'string' ? req.get('x-company-id') : null;

  return bodyId || queryId || headerId || 'DEFAULT';
}

function getIdentityContext({ vendor, rowData }) {
  const providerRaw = vendor || rowData.vendor || 'generic';
  const provider = typeof providerRaw === 'string' ? providerRaw.trim().toLowerCase() : 'generic';
  const identifierType = provider === 'zkteco' ? 'pin' : 'person_id';
  const identifierValue = typeof rowData.person_id === 'string' ? rowData.person_id.trim() : '';

  return { provider, identifierType, identifierValue };
}

function buildIdentityPayload(rawPayload, identityMeta) {
  const base = (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload))
    ? { ...rawPayload }
    : rawPayload !== undefined
      ? { original_raw_payload: rawPayload }
      : {};

  base.identity = {
    provider: identityMeta.provider,
    identifier_type: identityMeta.identifierType,
    identifier_value: identityMeta.identifierValue,
    mapping_applied: identityMeta.mappingApplied
  };

  return base;
}

/**
 * POST /api/device-events
 * Insert single device event (JSON)
 */
router.post('/', async (req, res) => {
  try {
    const {
      company_id,
      person_id,
      event_time_utc,
      direction,
      vendor = null,
      device_uid = null,
      raw_payload = null,
      provider,
      identifier_type,
      identifier_value
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

    let sanitizedDeviceUid;
    try {
      sanitizedDeviceUid = requireDeviceUid(device_uid);
    } catch (err) {
      if (err.code === 'DEVICE_ID_REQUIRED') {
        return res.status(400).json({ error: 'DEVICE_ID_REQUIRED' });
      }
      throw err;
    }

    const companyId = resolveCompanyId(req, req.body || {});
    let resolvedPersonId = person_id;

    const useIdentityMappings = process.env.USE_IDENTITY_MAPPINGS === '1';
    const hasIdentityInputs =
      typeof provider === 'string' && provider.trim() &&
      typeof identifier_type === 'string' && identifier_type.trim() &&
      typeof identifier_value === 'string' && identifier_value.trim();
    if (useIdentityMappings && hasIdentityInputs) {
      const resolution = await resolvePersonIdForIdentifier(db, {
        companyId,
        provider,
        identifierType: identifier_type,
        identifierValue: identifier_value
      });
      if (resolution.error === 'identity_mapping_missing') {
        return res.status(400).json({ error: 'identity_mapping_missing' });
      }
      resolvedPersonId = resolution.person_id || resolvedPersonId;
      parsedPayload = buildIdentityPayload(parsedPayload, {
        provider,
        identifierType: identifier_type,
        identifierValue: identifier_value,
        mappingApplied: resolution.applied === true
      });
    }

    await db.query(
      `
      INSERT INTO device_events
        (company_id, person_id, event_time_utc, direction, vendor, device_uid, raw_payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      `,
      [
        companyId,
        resolvedPersonId,
        event_time_utc,
        direction,
        vendor,
        sanitizedDeviceUid,
        parsedPayload
      ]
    );

    await invalidateAttendanceCache(db, resolvedPersonId, event_time_utc, { companyId });

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
  async (req, res) => {
    try {
      const csvText =
        req.body instanceof Buffer
          ? req.body.toString('utf8')
          : '';

      if (!csvText.trim()) {
        return res.status(400).json({ error: 'CSV content is required' });
      }

      const options = {};
      const vendor = getVendor(req);
      if (vendor) {
        options.vendor = vendor;
      }
      const delimiter = getDelimiter(req);
      if (delimiter) {
        options.delimiter = delimiter;
      }

      const validation = parseDeviceEventsCsv(csvText, options);
      const companyId = resolveCompanyId(req, null);

      if (Array.isArray(validation.rows)) {
        for (const row of validation.rows) {
          if (!row.valid) {
            continue;
          }
          row.data = row.data || {};
          const identityContext = getIdentityContext({
            vendor: vendor || row.data.vendor,
            rowData: row.data
          });

          const resolution = await resolvePersonIdForIdentifier(db, {
            companyId,
            provider: identityContext.provider,
            identifierType: identityContext.identifierType,
            identifierValue: identityContext.identifierValue
          });

          row.data.resolved_person_id = resolution.person_id || identityContext.identifierValue;
          row.data.identity_mapping_applied = resolution.applied === true;
          row.data.identity_mapping_reason = resolution.reason || 'missing';
          row.data.raw_payload = buildIdentityPayload(row.data.raw_payload, {
            provider: identityContext.provider,
            identifierType: identityContext.identifierType,
            identifierValue: identityContext.identifierValue,
            mappingApplied: resolution.applied === true
          });

          if (resolution.error === 'identity_mapping_missing') {
            const message = 'identity mapping not found';
            row.valid = false;
            row.errors = row.errors || [];
            row.errors.push({ code: 'identity_mapping_missing', message });
            validation.errors.push({
              row_number: row.row_number,
              code: 'identity_mapping_missing',
              message
            });
            validation.invalid_rows += 1;
            validation.valid_rows -= 1;
          }
        }
      }

      const timeInterpretationEnabled = isTimeInterpretationEnabled();
      const isZkteco = vendor === 'zkteco';

      const sample_valid_rows = validation.rows
        .filter(row => row.valid)
        .slice(0, 10)
        .map(row => {
          if (isZkteco || !timeInterpretationEnabled) {
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

      const previewResult = {
        system_version: SYSTEM_VERSION,
        contract: CSV_CONTRACT,
        import_version: CSV_IMPORT_VERSION,
        total_rows: validation.total_rows,
        valid_rows: validation.valid_rows,
        invalid_rows: validation.invalid_rows,
        errors: validation.errors,
        error_intelligence: buildErrorIntelligence(validation),
        sample_valid_rows
      };
      if (!previewResult.sample_rows) {
        previewResult.sample_rows = sample_valid_rows;
      }
      res.json(previewResult);
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
 * POST /api/device-events/import/preview/export-errors.csv
 * CSV preview errors export (no DB writes)
 */
router.post(
  '/import/preview/export-errors.csv',
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
      const vendor = getVendor(req);
      if (vendor) {
        options.vendor = vendor;
      }
      const delimiter = getDelimiter(req);
      if (delimiter) {
        options.delimiter = delimiter;
      }

      const validation = parseDeviceEventsCsv(csvText, options);
      const errorCsv = buildErrorsCsv(validation);

      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="device-events-preview-errors.csv"');
      return res.status(200).send(errorCsv);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'export failed' });
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
    const companyId = resolveCompanyId(req, null);

    if (!csvText.trim()) {
      return res.status(400).json({ error: 'CSV content is required' });
    }

    const options = {};
    const vendor = getVendor(req);
    if (vendor) {
      options.vendor = vendor;
    }
    const delimiter = getDelimiter(req);
    if (delimiter) {
      options.delimiter = delimiter;
    }
    const validationResult = parseDeviceEventsCsv(csvText, options);
    const missingRequired = validationResult.errors.some(
      err => err.code === 'MISSING_REQUIRED_COLUMN'
    );

    if (missingRequired) {
      return res.status(400).json(validationResult);
    }

    const identityByRow = new Map();
    if (Array.isArray(validationResult.rows)) {
      for (const row of validationResult.rows) {
        if (!row.valid) {
          continue;
        }
        const rowData = row.data || {};
        const identityContext = getIdentityContext({
          vendor: vendor || rowData.vendor,
          rowData
        });
        const resolution = await resolvePersonIdForIdentifier(db, {
          companyId,
          provider: identityContext.provider,
          identifierType: identityContext.identifierType,
          identifierValue: identityContext.identifierValue
        });
        if (resolution.error === 'identity_mapping_missing') {
          return res.status(400).json({
            error: 'identity_mapping_missing',
            row_number: row.row_number
          });
        }
        identityByRow.set(row.row_number, {
          provider: identityContext.provider,
          identifierType: identityContext.identifierType,
          identifierValue: identityContext.identifierValue,
          resolvedPersonId: resolution.person_id || identityContext.identifierValue,
          mappingApplied: resolution.applied === true
        });
      }
    }

    if (vendor === 'zkteco') {
      const errors = validationResult.errors.slice(0, 200);
      let inserted_rows = 0;
      let skipped_rows = 0;
      let failed_rows = validationResult.invalid_rows;
      const first3Inserted = [];
      const last3Inserted = [];

      for (const row of validationResult.rows) {
        if (!row.valid) {
          continue;
        }

        const normalized = normalizeCanonicalEvent(row.data);
        const identity = identityByRow.get(row.row_number);
        if (identity) {
          normalized.person_id = identity.resolvedPersonId;
          normalized.raw_payload = buildIdentityPayload(normalized.raw_payload, identity);
        }
        const validation = validateCanonicalEvent(normalized);
        if (!validation.ok) {
          if (errors.length < 200) {
            const details = validation.errors || [];
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
        try {
          normalized.device_uid = requireDeviceUid(normalized.device_uid);
        } catch (err) {
          if (errors.length < 200) {
            errors.push({
              row_number: row.row_number,
              code: 'MISSING_DEVICE_UID',
              message: 'device_uid is required'
            });
          }
          failed_rows += 1;
          continue;
        }

        const companyId = normalized.company_id || 'DEFAULT';
        const values = [
          companyId,
          normalized.person_id,
          normalized.event_time_utc,
          normalized.direction,
          normalized.vendor,
          normalized.device_uid,
          normalized.raw_payload
        ];

        let result;
        try {
          result = await db.query(
            `
            INSERT INTO device_events
              (company_id, person_id, event_time_utc, direction, vendor, device_uid, raw_payload)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
            ON CONFLICT ON CONSTRAINT device_events_dedup_company_uk DO NOTHING
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
            await invalidateAttendanceCache(db, normalized.person_id, normalized.event_time_utc, {
              companyId
            });
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
      const identity = identityByRow.get(row.row_number);
      if (identity) {
        canonical.person_id = identity.resolvedPersonId;
        canonical.raw_payload = buildIdentityPayload(canonical.raw_payload, identity);
      }
      try {
        canonical.device_uid = requireDeviceUid(canonical.device_uid);
      } catch (err) {
        if (errors.length < 200) {
          errors.push({
            row_number: row.row_number,
            code: 'MISSING_DEVICE_UID',
            message: 'device_uid is required'
          });
        }
        failed_rows += 1;
        continue;
      }

      const companyId = canonical.company_id || 'DEFAULT';
      const values = [
        companyId,
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
            (company_id, person_id, event_time_utc, direction, vendor, device_uid, raw_payload)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
          ON CONFLICT ON CONSTRAINT device_events_dedup_company_uk DO NOTHING
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
          await invalidateAttendanceCache(db, canonical.person_id, canonical.event_time_utc, {
            companyId
          });
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
