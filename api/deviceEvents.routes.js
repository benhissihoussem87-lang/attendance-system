const express = require('express');
const router = express.Router();

const db = require('../db');
const { invalidateAttendanceCache } = require('../services/cacheInvalidation');
const { parseDeviceEventsCsv } = require('../services/deviceEventsCsvValidator');
const { importDeviceEventsCsv } = require('../services/deviceEventsCsvImporter');
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

function resolveImportCompanyId(req) {
  const authCompanyId = (req.ctx && typeof req.ctx.company_id === 'string')
    ? req.ctx.company_id.trim()
    : '';
  if (authCompanyId) {
    return authCompanyId;
  }

  const allowFallback = toBool(process.env.ALLOW_TEST_ENDPOINTS) || !toBool(process.env.REQUIRE_AUTH);
  if (!allowFallback) {
    return '';
  }

  const fallback = resolveCompanyId(req, null);
  if (typeof fallback !== 'string') {
    return '';
  }
  return fallback.trim();
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
      const effectiveCompanyId = resolveImportCompanyId(req);
      if (!effectiveCompanyId) {
        return sendError(res, {
          status: 400,
          code: 'IMPORT_ERROR',
          message: 'Import error',
          details: {
            kind: 'import_error',
            error: 'company_scope_required'
          }
        });
      }
      if (inferredCompany && inferredCompany.value && inferredCompany.value !== effectiveCompanyId) {
        return sendError(res, {
          status: 400,
          code: 'IMPORT_ERROR',
          message: 'Import error',
          details: {
            kind: 'import_error',
            error: 'company_id_mismatch'
          }
        });
      }
      const companyId = effectiveCompanyId;

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
      const effectiveCompanyId = resolveImportCompanyId(req);
      if (!effectiveCompanyId) {
        return sendError(res, {
          status: 400,
          code: 'IMPORT_ERROR',
          message: 'Import error',
          details: {
            kind: 'import_error',
            error: 'company_scope_required'
          }
        });
      }
      if (inferredCompany && inferredCompany.value && inferredCompany.value !== effectiveCompanyId) {
        return sendError(res, {
          status: 400,
          code: 'IMPORT_ERROR',
          message: 'Import error',
          details: {
            kind: 'import_error',
            error: 'company_id_mismatch'
          }
        });
      }
      const companyId = effectiveCompanyId;

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

    const commitResult = await importDeviceEventsCsv(db, csvText, companyId, {
      ...options,
      vendor,
      validationResult,
      identityByRow,
      companyTimezone: COMPANY_TIMEZONE,
      timeInterpretationEnabled: isTimeInterpretationEnabled()
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: companyId,
      role: req.ctx ? req.ctx.role : null,
      action: 'device_events.import.commit',
      target: req.originalUrl || req.path,
      metadata: {
        vendor,
        total_rows: commitResult.total_rows,
        valid_rows: commitResult.valid_rows,
        invalid_rows: commitResult.invalid_rows,
        inserted_rows: commitResult.inserted_rows,
        skipped_rows: commitResult.skipped_rows,
        failed_rows: commitResult.failed_rows
      }
    });
    return res.json({
        system_version: SYSTEM_VERSION,
        contract: CSV_CONTRACT,
        import_version: CSV_IMPORT_VERSION,
        total_rows: commitResult.total_rows,
        valid_rows: commitResult.valid_rows,
        invalid_rows: commitResult.invalid_rows,
        inserted_rows: commitResult.inserted_rows,
        skipped_rows: commitResult.skipped_rows,
        failed_rows: commitResult.failed_rows,
        errors: commitResult.errors,
        inserted_samples: commitResult.inserted_samples
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
