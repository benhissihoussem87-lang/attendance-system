const { deriveWorkDate } = require('./dayBoundary');
const { getCompanyConfig } = require('./companyConfigProvider');
const { toBool } = require('./envBool');

async function invalidateAttendanceCache(db, personId, eventTimeUtc, opts = {}) {
  const companyId = opts.companyId || 'DEFAULT';

  const dt = new Date(eventTimeUtc);
  if (Number.isNaN(dt.getTime())) {
    // Never throw from invalidation; ingestion must remain robust.
    return;
  }

  // Existing behavior: UTC date derived from event_time_utc
  const utcDate = dt.toISOString().slice(0, 10);

  // Derived work_date (anchored boundary aware) when enabled
  let derivedDate = null;
  if (toBool(process.env.USE_DERIVED_WORK_DATE)) {
    const config = await getCompanyConfig(db, companyId);
    const derived = deriveWorkDate({
      event_time_utc: dt.toISOString(),
      company_timezone: config.company_timezone,
      night_shift_enabled: config.night_shift_enabled,
      day_start_time: config.day_start_time
    });
    derivedDate = derived.work_date;
  }

  // Delete a safe superset: UTC date + derived work_date (if present)
  const dates = Array.from(new Set([utcDate, derivedDate].filter(Boolean)));

  await db.query(
    `
    DELETE FROM attendance_days
    WHERE company_id = $1
      AND person_id = $2
      AND work_date = ANY($3::date[])
    `,
    [companyId, personId, dates]
  );
}

module.exports = { invalidateAttendanceCache };
