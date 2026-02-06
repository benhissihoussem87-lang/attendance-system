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
const { shouldRequireIdentityMappingForProvider } = require('../services/identityMappingPolicy');
const { toBool } = require('../services/envBool');
const {
  SYSTEM_VERSION,
  CSV_IMPORT_VERSION,
  CSV_CONTRACT
} = require('../contracts/systemContracts');
const { upsertDeviceMinimal } = require('../services/devicesDb');
const {
  getIdentityContext: getAdapterIdentityContext,
  getSupportedVendors
} = require('../adapters/vendors/registry');
const { emitAuditEvent } = require('../services/auditLogger');
const { requireApiKey, requireRole, enforceCompanyScope } = require('./lib/auth');
const { sendError } = require('./lib/errorEnvelope');

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

function isPlainText(req) {
  const contentType = String(req.get('content-type') || '').toLowerCase();
  return contentType.includes('text/plain') || contentType.includes('text/txt');
}

function resolveCompanyId(req, body) {
  if (req.ctx && req.ctx.company_id) {
    return req.ctx.company_id;
  }
  const bodyId = body && typeof body.company_id === 'string' ? body.company_id : null;
  const queryId = req.query && typeof req.query.company_id === 'string' ? req.query.company_id : null;
  const headerId = typeof req.get('x-company-id') === 'string' ? req.get('x-company-id') : null;

  return bodyId || queryId || headerId || null;
}

function inferCompanyIdFromRows(rows) {
  if (!Array.isArray(rows)) {
    return null;
  }

  let found = null;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    const data = row.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      continue;
    }
    const value = data.company_id;
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    if (found && found !== trimmed) {
      return { error: 'mixed_company_id' };
    }
    found = trimmed;
  }

  if (!found) {
    return null;
  }
  return { value: found };
}

function getIdentityContext({ vendor, rowData }) {
  const extracted = getAdapterIdentityContext({ vendor, rowData });
  return {
    provider: extracted.provider,
    identifierType: extracted.identifier_type,
    identifierValue: extracted.identifier_value
  };
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
router.post('/', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
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
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'missing_required_fields',
          detail: 'Missing required fields'
        }
      });
    }

    if (!['IN', 'OUT'].includes(direction)) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_direction',
          detail: 'Invalid direction'
        }
      });
    }

    if (typeof raw_payload === 'string') {
      try {
        parsedPayload = JSON.parse(raw_payload);
      } catch (err) {
        return sendError(res, {
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: {
            kind: 'validation',
            error: 'invalid_raw_payload',
            detail: 'Invalid raw_payload JSON'
          }
        });
      }
    }

    let sanitizedDeviceUid;
    try {
      sanitizedDeviceUid = requireDeviceUid(device_uid);
    } catch (err) {
      if (err.code === 'DEVICE_ID_REQUIRED') {
        return sendError(res, {
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: {
            kind: 'validation',
            error: 'DEVICE_ID_REQUIRED',
            detail: 'DEVICE_ID_REQUIRED'
          }
        });
      }
      throw err;
    }

    const companyId = resolveCompanyId(req, req.body || {}) || 'DEFAULT';
    let resolvedPersonId = person_id;

    const useIdentityMappings = toBool(process.env.USE_IDENTITY_MAPPINGS);
    const providerRaw = (typeof provider === 'string' && provider.trim())
      ? provider
      : (typeof vendor === 'string' && vendor.trim())
        ? vendor
        : 'generic';
    const providerValue = providerRaw.trim().toLowerCase();
    const identifierTypeValue = typeof identifier_type === 'string'
      ? identifier_type.trim().toLowerCase()
      : '';
    const identifierValueValue = typeof identifier_value === 'string'
      ? identifier_value.trim()
      : '';
    const hasIdentityInputs = Boolean(providerValue && identifierTypeValue && identifierValueValue);
    if (useIdentityMappings) {
      const requireMappings = shouldRequireIdentityMappingForProvider(providerValue);
      const resolution = await resolvePersonIdForIdentifier(db, {
        companyId,
        provider: providerValue,
        identifierType: identifierTypeValue,
        identifierValue: identifierValueValue,
        requireMappings
      });
      if (resolution.error === 'identity_mapping_missing') {
        return sendError(res, {
          status: 400,
          code: 'INGEST_ERROR',
          message: 'Ingest error',
          details: {
            kind: 'ingest_error',
            error: 'identity_mapping_missing'
          }
        });
      }
      resolvedPersonId = resolution.person_id || resolvedPersonId;
      if (hasIdentityInputs) {
        parsedPayload = buildIdentityPayload(parsedPayload, {
          provider: providerValue,
          identifierType: identifierTypeValue,
          identifierValue: identifierValueValue,
          mappingApplied: resolution.applied === true
        });
      }
    }

    const autoMetadata = { source: 'ingest' };
    if (providerValue) {
      autoMetadata.vendor = providerValue;
    }
    await upsertDeviceMinimal(db, companyId, sanitizedDeviceUid, {
      provider: providerValue || null,
      metadata: autoMetadata
    });

    if (parsedPayload === null || parsedPayload === undefined) {
      parsedPayload = (raw_payload !== null && raw_payload !== undefined)
        ? raw_payload
        : (req.body || {});
      if (parsedPayload === null || parsedPayload === undefined) {
        parsedPayload = {};
      }
    }

    const insertResult = await db.query(
      `
      INSERT INTO device_events
        (company_id, person_id, event_time_utc, direction, vendor, device_uid, raw_payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT ON CONSTRAINT device_events_dedup_company_uk DO NOTHING
      RETURNING person_id, event_time_utc, direction, device_uid, vendor
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

    if (insertResult.rowCount === 0) {
      return res.status(200).json({ status: 'ok', dedup: true });
    }

    await invalidateAttendanceCache(db, resolvedPersonId, event_time_utc, { companyId });

    res.status(201).json({ status: 'ok' });
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

/**
 * POST /api/device-events/import/preview
 * CSV preview ONLY (no DB writes)
 * Accepts raw text/plain CSV
 */
router.post(
  '/import/preview',
  requireApiKey,
  enforceCompanyScope,
  requireRole('operator'),
  express.raw({ type: '*/*', limit: '10mb' }),
  async (req, res) => {
    try {
      const csvText =
        req.body instanceof Buffer
          ? req.body.toString('utf8')
          : '';

      if (!csvText.trim()) {
        return sendError(res, {
          status: 400,
          code: 'CSV_VALIDATION',
          message: 'CSV validation failed',
          details: {
            kind: 'csv_validation',
            error: 'CSV content is required'
          }
        });
      }

      const options = {};
      const vendor = getVendor(req);
      if (vendor) {
        options.vendor = vendor;
      }
      if (vendor === 'anviz' && isPlainText(req)) {
        options.delimiter = '\t';
      }
      const delimiter = getDelimiter(req);
      if (delimiter) {
        options.delimiter = delimiter;
      }

      const validation = parseDeviceEventsCsv(csvText, options);
      const unknownVendorError = validation.errors.find(err => err.code === 'UNKNOWN_VENDOR');
      if (unknownVendorError) {
        return sendError(res, {
          status: 400,
          code: 'IMPORT_ERROR',
          message: 'Import error',
          details: {
            kind: 'import_error',
            error: 'unknown_vendor',
            detail: unknownVendorError.message,
            supported_vendors: getSupportedVendors()
          }
        });
      }
      const inferredCompany = inferCompanyIdFromRows(validation.rows);
      if (inferredCompany && inferredCompany.error === 'mixed_company_id') {
        return sendError(res, {
          status: 400,
          code: 'IMPORT_ERROR',
          message: 'Import error',
          details: {
            kind: 'import_error',
            error: 'mixed_company_id'
          }
        });
      }
      const resolvedCompanyId = resolveCompanyId(req, null);
      if (resolvedCompanyId && inferredCompany && inferredCompany.value && inferredCompany.value !== resolvedCompanyId) {
        return sendError(res, {
          status: 400,
          code: 'IMPORT_ERROR',
          message: 'Import error',
          details: {
            kind: 'import_error',
            error: 'company_mismatch'
          }
        });
      }
      const companyId = resolvedCompanyId || (inferredCompany && inferredCompany.value) || 'DEFAULT';

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
          const requireMappings = shouldRequireIdentityMappingForProvider(identityContext.provider);

          const resolution = await resolvePersonIdForIdentifier(db, {
            companyId,
            provider: identityContext.provider,
            identifierType: identityContext.identifierType,
            identifierValue: identityContext.identifierValue,
            requireMappings
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
      emitAuditEvent({
        actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
        company_id: companyId,
        role: req.ctx ? req.ctx.role : null,
        action: 'device_events.import.preview',
        target: req.originalUrl || req.path,
        metadata: {
          vendor,
          total_rows: previewResult.total_rows,
          valid_rows: previewResult.valid_rows,
          invalid_rows: previewResult.invalid_rows
        }
      });
      res.json(previewResult);
    } catch (err) {
      console.error(err);
      if (err && err.code === 'TIME_INTERPRETATION_FAILED') {
        return sendError(res, {
          status: 400,
          code: 'CSV_VALIDATION',
          message: 'CSV validation failed',
          details: {
            kind: 'csv_validation',
            error: 'Time interpretation failed',
            details: err.message || 'Invalid event_time'
          }
        });
      }
      return sendError(res, {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'Server error'
      });
    }
  }
);

/**
 * POST /api/device-events/import/preview/export-errors.csv
 * CSV preview errors export (no DB writes)
 */
router.post(
  '/import/preview/export-errors.csv',
  requireApiKey,
  enforceCompanyScope,
  requireRole('operator'),
  express.raw({ type: '*/*', limit: '10mb' }),
  (req, res) => {
    try {
      const csvText =
        req.body instanceof Buffer
          ? req.body.toString('utf8')
          : '';

      if (!csvText.trim()) {
        return sendError(res, {
          status: 400,
          code: 'CSV_VALIDATION',
          message: 'CSV validation failed',
          details: {
            kind: 'csv_validation',
            error: 'CSV content is required'
          }
        });
      }

      const options = {};
      const vendor = getVendor(req);
      if (vendor) {
        options.vendor = vendor;
      }
      if (vendor === 'anviz' && isPlainText(req)) {
        options.delimiter = '\t';
      }
      const delimiter = getDelimiter(req);
      if (delimiter) {
        options.delimiter = delimiter;
      }

      const validation = parseDeviceEventsCsv(csvText, options);
      const unknownVendorError = validation.errors.find(err => err.code === 'UNKNOWN_VENDOR');
      if (unknownVendorError) {
        return sendError(res, {
          status: 400,
          code: 'IMPORT_ERROR',
          message: 'Import error',
          details: {
            kind: 'import_error',
            error: 'unknown_vendor',
            detail: unknownVendorError.message,
            supported_vendors: getSupportedVendors()
          }
        });
      }
      const errorCsv = buildErrorsCsv(validation);

      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="device-events-preview-errors.csv"');
      return res.status(200).send(errorCsv);
    } catch (err) {
      console.error(err);
      return sendError(res, {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'Server error'
      });
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
  requireApiKey,
  enforceCompanyScope,
  requireRole('operator'),
  express.raw({ type: '*/*', limit: '10mb' }),
  async (req, res) => {
    try {
      const csvText =
        req.body instanceof Buffer
          ? req.body.toString('utf8')
          : '';

      if (!csvText.trim()) {
        return sendError(res, {
          status: 400,
          code: 'CSV_VALIDATION',
          message: 'CSV validation failed',
          details: {
            kind: 'csv_validation',
            error: 'CSV content is required'
          }
        });
      }

      const options = {};
      const vendor = getVendor(req);
      if (vendor) {
        options.vendor = vendor;
      }
      if (vendor === 'anviz' && isPlainText(req)) {
        options.delimiter = '\t';
      }
      const delimiter = getDelimiter(req);
      if (delimiter) {
        options.delimiter = delimiter;
      }
      const validationResult = parseDeviceEventsCsv(csvText, options);
      const unknownVendorError = validationResult.errors.find(err => err.code === 'UNKNOWN_VENDOR');
      if (unknownVendorError) {
        return sendError(res, {
          status: 400,
          code: 'IMPORT_ERROR',
          message: 'Import error',
          details: {
            kind: 'import_error',
            error: 'unknown_vendor',
            detail: unknownVendorError.message,
            supported_vendors: getSupportedVendors()
          }
        });
      }
      const missingRequired = validationResult.errors.some(
        err => err.code === 'MISSING_REQUIRED_COLUMN'
      );

      if (missingRequired) {
        return sendError(res, {
          status: 400,
          code: 'CSV_VALIDATION',
          message: 'CSV validation failed',
          details: {
            kind: 'csv_validation',
            ...validationResult
          }
        });
      }

      const inferredCompany = inferCompanyIdFromRows(validationResult.rows);
      if (inferredCompany && inferredCompany.error === 'mixed_company_id') {
        return sendError(res, {
          status: 400,
          code: 'IMPORT_ERROR',
          message: 'Import error',
          details: {
            kind: 'import_error',
            error: 'mixed_company_id'
          }
        });
      }
      const resolvedCompanyId = resolveCompanyId(req, null);
      if (resolvedCompanyId && inferredCompany && inferredCompany.value && inferredCompany.value !== resolvedCompanyId) {
        return sendError(res, {
          status: 400,
          code: 'IMPORT_ERROR',
          message: 'Import error',
          details: {
            kind: 'import_error',
            error: 'company_mismatch'
          }
        });
      }
      const companyId = resolvedCompanyId || (inferredCompany && inferredCompany.value) || 'DEFAULT';

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
        const requireMappings = shouldRequireIdentityMappingForProvider(identityContext.provider);
        const resolution = await resolvePersonIdForIdentifier(db, {
          companyId,
          provider: identityContext.provider,
          identifierType: identityContext.identifierType,
          identifierValue: identityContext.identifierValue,
          requireMappings
        });
        if (resolution.error === 'identity_mapping_missing') {
          return sendError(res, {
            status: 400,
            code: 'IMPORT_ERROR',
            message: 'Import error',
            details: {
              kind: 'import_error',
              error: 'identity_mapping_missing',
              row_number: row.row_number
            }
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

        const normalizedVendor = typeof normalized.vendor === 'string' ? normalized.vendor.trim() : '';
        const autoVendor = normalizedVendor
          ? normalizedVendor.toLowerCase()
          : (typeof vendor === 'string' && vendor.trim() ? vendor.trim().toLowerCase() : null);
        const autoMetadata = { source: 'ingest' };
        if (autoVendor) {
          autoMetadata.vendor = autoVendor;
        }
        await upsertDeviceMinimal(db, companyId, normalized.device_uid, {
          provider: autoVendor,
          metadata: autoMetadata
        });
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

      emitAuditEvent({
        actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
        company_id: companyId,
        role: req.ctx ? req.ctx.role : null,
        action: 'device_events.import.commit',
        target: req.originalUrl || req.path,
        metadata: {
          vendor,
          total_rows: validationResult.total_rows,
          valid_rows: validationResult.valid_rows,
          invalid_rows: validationResult.invalid_rows,
          inserted_rows,
          skipped_rows,
          failed_rows
        }
      });
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

      const canonicalVendor = typeof canonical.vendor === 'string' ? canonical.vendor.trim() : '';
      const autoVendor = canonicalVendor
        ? canonicalVendor.toLowerCase()
        : (typeof vendor === 'string' && vendor.trim() ? vendor.trim().toLowerCase() : null);
      const autoMetadata = { source: 'ingest' };
      if (autoVendor) {
        autoMetadata.vendor = autoVendor;
      }
      await upsertDeviceMinimal(db, companyId, canonical.device_uid, {
        provider: autoVendor,
        metadata: autoMetadata
      });
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

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'device_events.import.commit',
      target: req.originalUrl || req.path,
      metadata: {
        vendor,
        total_rows: validationResult.total_rows,
        valid_rows: validationResult.valid_rows,
        invalid_rows: validationResult.invalid_rows,
        inserted_rows,
        skipped_rows,
        failed_rows
      }
    });
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
    } catch (err) {
      console.error(err);
      return sendError(res, {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'Server error'
      });
    }
  }
);

module.exports = router;
