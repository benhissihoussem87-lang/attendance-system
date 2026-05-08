const { validateDeviceEventsCsv, parseDeviceEventsCsv } = require('./deviceEventsCsvValidator');
const { invalidateAttendanceCache } = require('./cacheInvalidation');
const { mapAndValidateEvents } = require('./deviceEventIngestor');
const { normalizeCanonicalEvent } = require('../contracts/deviceEventContract');
const { validateCanonicalEvent } = require('./validators/deviceEventValidator');
const { requireDeviceUid } = require('./validators/deviceIdentity');
const { COMPANY_TIMEZONE } = require('../config/timezone');
const {
  interpretEventTime,
  isTimeInterpretationEnabled
} = require('./timeInterpreter');
const { buildDedupKey } = require('../contracts/agentDeviceEventsContract');
const { upsertDeviceMinimal } = require('./devicesDb');

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

function pushInsertedSample(first3Inserted, last3Inserted, sampleItem) {
  if (first3Inserted.length < 3) {
    first3Inserted.push(sampleItem);
  }
  last3Inserted.push(sampleItem);
  if (last3Inserted.length > 3) {
    last3Inserted.shift();
  }
}

function normalizeIsoOrRaw(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

async function importDeviceEventsCsv(db, csvText, companyId, options = {}) {
  const effectiveCompanyId = (typeof companyId === 'string') ? companyId.trim() : '';
  if (!effectiveCompanyId) {
    const err = new Error('companyId is required');
    err.code = 'COMPANY_SCOPE_REQUIRED';
    throw err;
  }

  const importOptions = (options && typeof options === 'object' && !Array.isArray(options))
    ? options
    : {};

  // Keep an explicit validator call in the write service so commit logic and validation stay co-located.
  const baseValidation = validateDeviceEventsCsv(csvText, importOptions);
  const parseOptions = {
    ...importOptions
  };
  const validationResult = (
    importOptions.validationResult &&
    typeof importOptions.validationResult === 'object' &&
    Array.isArray(importOptions.validationResult.rows)
  )
    ? importOptions.validationResult
    : (parseOptions.vendor ? parseDeviceEventsCsv(csvText, parseOptions) : baseValidation);

  const missingRequired = Array.isArray(validationResult.errors) && validationResult.errors.some(
    error => error.code === 'MISSING_REQUIRED_COLUMN'
  );

  if (missingRequired) {
    return {
      total_rows: validationResult.total_rows || 0,
      valid_rows: validationResult.valid_rows || 0,
      invalid_rows: validationResult.invalid_rows || 0,
      inserted_rows: 0,
      skipped_rows: 0,
      failed_rows: 0,
      errors: Array.isArray(validationResult.errors) ? validationResult.errors.slice(0, 200) : [],
      inserted_samples: {
        first3: [],
        last3: []
      }
    };
  }

  const vendor = importOptions.vendor || null;
  const identityByRow = importOptions.identityByRow instanceof Map
    ? importOptions.identityByRow
    : new Map();
  const timeInterpretationEnabled = (typeof importOptions.timeInterpretationEnabled === 'boolean')
    ? importOptions.timeInterpretationEnabled
    : isTimeInterpretationEnabled();
  const companyTimezone = (typeof importOptions.companyTimezone === 'string' && importOptions.companyTimezone.trim())
    ? importOptions.companyTimezone.trim()
    : COMPANY_TIMEZONE;

  const errors = Array.isArray(validationResult.errors)
    ? validationResult.errors.slice(0, 200)
    : [];
  let inserted_rows = 0;
  let skipped_rows = 0;
  let failed_rows = Number.isFinite(validationResult.invalid_rows)
    ? Number(validationResult.invalid_rows)
    : 0;
  const first3Inserted = [];
  const last3Inserted = [];
  const rows = Array.isArray(validationResult.rows) ? validationResult.rows : [];

  if (vendor === 'zkteco') {
    for (const row of rows) {
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
      await upsertDeviceMinimal(db, effectiveCompanyId, normalized.device_uid, {
        provider: autoVendor,
        metadata: autoMetadata
      });
      const values = [
        effectiveCompanyId,
        normalized.person_id,
        normalizeIsoOrRaw(normalized.event_time_utc),
        normalized.direction,
        normalized.vendor,
        normalized.device_uid,
        normalized.raw_payload,
        'csv_import',
        buildDedupKey({
          vendor: (identity && identity.provider) || autoVendor || normalized.vendor || 'generic',
          deviceUid: normalized.device_uid,
          devicePersonId: (identity && identity.identifierValue) || normalized.person_id,
          eventTimeUtc: normalizeIsoOrRaw(normalized.event_time_utc),
          direction: normalized.direction,
          verifyState: '',
          verifyMethod: ''
        }),
        (identity && identity.identifierValue) || normalized.person_id,
        JSON.stringify({
          ingest_method: 'csv_import',
          mapped_person_id: normalized.person_id,
          mapping_applied: Boolean(identity && identity.mappingApplied),
          mapping_reason: identity
            ? (identity.mappingApplied ? 'mapped' : 'missing')
            : 'missing',
          identity_provider: (identity && identity.provider) || autoVendor || null,
          identity_type: (identity && identity.identifierType) || null,
          identity_value: (identity && identity.identifierValue) || null
        })
      ];

      let result;
      try {
        result = await db.query(
          `
          INSERT INTO device_events
            (company_id, person_id, event_time_utc, direction, vendor, device_uid, raw_payload,
             ingest_method, dedup_key, device_person_id, source_metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)
          ON CONFLICT DO NOTHING
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
            companyId: effectiveCompanyId
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
        pushInsertedSample(first3Inserted, last3Inserted, sampleItem);
      } else {
        skipped_rows += 1;
      }
    }

    return {
      total_rows: validationResult.total_rows || 0,
      valid_rows: validationResult.valid_rows || 0,
      invalid_rows: validationResult.invalid_rows || 0,
      inserted_rows,
      skipped_rows,
      failed_rows,
      errors,
      inserted_samples: {
        first3: first3Inserted,
        last3: last3Inserted
      }
    };
  }

  for (const row of rows) {
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
          company_timezone: companyTimezone
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
    await upsertDeviceMinimal(db, effectiveCompanyId, canonical.device_uid, {
      provider: autoVendor,
      metadata: autoMetadata
    });
    const values = [
      effectiveCompanyId,
      canonical.person_id,
      normalizeIsoOrRaw(canonical.event_time_utc),
      canonical.direction,
      canonical.vendor,
      canonical.device_uid,
      canonical.raw_payload,
      'csv_import',
      buildDedupKey({
        vendor: (identity && identity.provider) || autoVendor || canonical.vendor || 'generic',
        deviceUid: canonical.device_uid,
        devicePersonId: (identity && identity.identifierValue) || canonical.person_id,
        eventTimeUtc: normalizeIsoOrRaw(canonical.event_time_utc),
        direction: canonical.direction,
        verifyState: '',
        verifyMethod: ''
      }),
      (identity && identity.identifierValue) || canonical.person_id,
      JSON.stringify({
        ingest_method: 'csv_import',
        mapped_person_id: canonical.person_id,
        mapping_applied: Boolean(identity && identity.mappingApplied),
        mapping_reason: identity
          ? (identity.mappingApplied ? 'mapped' : 'missing')
          : 'missing',
        identity_provider: (identity && identity.provider) || autoVendor || null,
        identity_type: (identity && identity.identifierType) || null,
        identity_value: (identity && identity.identifierValue) || null
      })
    ];

    let result;
    try {
      result = await db.query(
        `
        INSERT INTO device_events
          (company_id, person_id, event_time_utc, direction, vendor, device_uid, raw_payload,
           ingest_method, dedup_key, device_person_id, source_metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)
        ON CONFLICT DO NOTHING
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
          companyId: effectiveCompanyId
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
      pushInsertedSample(first3Inserted, last3Inserted, sampleItem);
    } else {
      skipped_rows += 1;
    }
  }

  return {
    total_rows: validationResult.total_rows || 0,
    valid_rows: validationResult.valid_rows || 0,
    invalid_rows: validationResult.invalid_rows || 0,
    inserted_rows,
    skipped_rows,
    failed_rows,
    errors,
    inserted_samples: {
      first3: first3Inserted,
      last3: last3Inserted
    }
  };
}

module.exports = { importDeviceEventsCsv };
