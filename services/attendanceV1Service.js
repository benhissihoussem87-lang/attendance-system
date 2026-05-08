const { DateTime } = require('luxon');
const { listDevices } = require('./devicesDb');
const { listSites } = require('./sitesDb');

function text(value) {
  return value == null ? '' : String(value);
}

function trim(value) {
  return text(value).trim();
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(value))) return false;
  return DateTime.fromISO(value, { zone: 'utc' }).isValid;
}

function parseLimit(value, fallback = 200, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseBool(value) {
  if (typeof value === 'boolean') return value;
  const normalized = trim(value).toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function validTimeZone(value) {
  const zone = trim(value);
  if (!zone) return '';
  return DateTime.now().setZone(zone).isValid ? zone : '';
}

function metadataOf(row) {
  return row && row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata
    : {};
}

function siteTimezone(site, fallback) {
  const metadata = metadataOf(site);
  return validTimeZone(metadata.timezone || site.timezone || fallback) || 'UTC';
}

function enumerateDates(startDate, endDate) {
  const out = [];
  let cursor = DateTime.fromISO(startDate, { zone: 'utc' });
  const end = DateTime.fromISO(endDate, { zone: 'utc' });
  while (cursor <= end) {
    out.push(cursor.toISODate());
    cursor = cursor.plus({ days: 1 });
  }
  return out;
}

function utcWindowForLocalDate(localDate, timeZone) {
  const start = DateTime.fromISO(localDate, { zone: timeZone }).startOf('day');
  const end = start.plus({ days: 1 });
  return {
    window_start_utc: start.toUTC().toISO(),
    window_end_utc: end.toUTC().toISO()
  };
}

function eventDeviceUserId(event) {
  return trim(event.device_person_id) || trim(event.person_id);
}

function serializeEmployee(row, mappings) {
  const metadata = metadataOf(row);
  return {
    person_id: row.person_id,
    employee_code: row.employee_code,
    employee_name: row.full_name,
    active: row.active,
    metadata,
    mapped_device_user_ids: mappings.map(mapping => mapping.identifier_value)
  };
}

function isValidationEmployee(row) {
  const metadata = metadataOf(row);
  return metadata.validation_user === true || metadata.not_for_client_reports === true;
}

async function loadProductEmployees(db, { companyId, personId, includeValidation, limit }) {
  const params = [companyId];
  const where = [
    `company_id = $1`,
    `active = true`,
    `metadata->>'product_managed' = 'true'`
  ];
  if (!includeValidation) {
    where.push(`COALESCE(metadata->>'validation_user', 'false') <> 'true'`);
    where.push(`COALESCE(metadata->>'not_for_client_reports', 'false') <> 'true'`);
  }
  if (personId) {
    params.push(personId);
    where.push(`person_id = $${params.length}`);
  }
  params.push(limit);

  const res = await db.query(`
    SELECT company_id, person_id, employee_code, full_name, default_rule_set_id,
           active, metadata, created_at, updated_at
    FROM employees
    WHERE ${where.join(' AND ')}
    ORDER BY employee_code ASC, full_name ASC, person_id ASC
    LIMIT $${params.length}
  `, params);
  return res.rows;
}

async function loadMappings(db, { companyId, personIds }) {
  if (!personIds.length) return [];
  const res = await db.query(`
    SELECT company_id, provider, identifier_type, identifier_value, person_id, active, metadata
    FROM identity_mappings
    WHERE company_id = $1
      AND active = true
      AND provider = 'zkteco'
      AND identifier_type = 'device_user_id'
      AND person_id = ANY($2::text[])
    ORDER BY identifier_value ASC
  `, [companyId, personIds]);
  return res.rows;
}

function buildEmployeeMaps(employees, mappings) {
  const byPerson = new Map();
  employees.forEach(row => byPerson.set(row.person_id, { employee: row, mappings: [] }));
  mappings.forEach(mapping => {
    const entry = byPerson.get(mapping.person_id);
    if (entry) entry.mappings.push(mapping);
  });
  const byDeviceUser = new Map();
  mappings.forEach(mapping => {
    const value = trim(mapping.identifier_value);
    if (value && byPerson.has(mapping.person_id)) {
      byDeviceUser.set(value, byPerson.get(mapping.person_id));
    }
  });
  return { byPerson, byDeviceUser };
}

function deriveDailyStatus(events) {
  if (!events.length) {
    return {
      status: 'no_facts',
      status_basis: 'no trusted full-history facts in selected date window',
      warnings: []
    };
  }
  const directions = events.map(row => trim(row.direction).toUpperCase()).filter(Boolean);
  const warnings = [];
  if (directions[0] === 'OUT') {
    warnings.push('first event is OUT');
    return {
      status: 'invalid',
      status_basis: 'first event is OUT',
      warnings
    };
  }
  for (let index = 1; index < directions.length; index += 1) {
    if ((directions[index] === 'IN' || directions[index] === 'OUT') && directions[index] === directions[index - 1]) {
      warnings.push('repeated direction sequence');
      return {
        status: 'invalid',
        status_basis: 'non-alternating IN/OUT sequence',
        warnings
      };
    }
  }
  if (directions.includes('IN') && directions.includes('OUT')) {
    return {
      status: 'complete_day',
      status_basis: 'trusted full-history facts contain IN and OUT punches',
      warnings
    };
  }
  return {
    status: 'incomplete',
    status_basis: events.length === 1
      ? 'one trusted punch only'
      : 'trusted punches exist but no clear IN/OUT pair',
    warnings
  };
}

function pushGrouped(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function sortEvents(events) {
  return events.slice().sort((a, b) => new Date(a.event_time_utc) - new Date(b.event_time_utc));
}

async function loadEvents(db, { companyId, deviceUids, minUtc, maxUtc }) {
  if (!deviceUids.length || !minUtc || !maxUtc) return [];
  const res = await db.query(`
    SELECT id, company_id, device_uid, person_id, device_person_id, event_time_utc,
           event_time_local, device_timezone, direction, source_metadata
    FROM device_events
    WHERE company_id = $1
      AND device_uid = ANY($2::text[])
      AND event_time_utc >= $3::timestamptz
      AND event_time_utc < $4::timestamptz
    ORDER BY event_time_utc ASC, id ASC
  `, [companyId, deviceUids, minUtc, maxUtc]);
  return res.rows;
}

function buildRowsForSite({ site, timeZone, dateList, devices, events, byDeviceUser, includeValidation }) {
  const deviceByUid = new Map(devices.map(device => [device.device_uid, device]));
  const eventsByEmployeeDay = new Map();
  const unmappedByKey = new Map();
  const windows = new Map(dateList.map(localDate => [localDate, utcWindowForLocalDate(localDate, timeZone)]));

  events.forEach(event => {
    const device = deviceByUid.get(event.device_uid);
    if (!device) return;
    const localDate = DateTime.fromJSDate(event.event_time_utc, { zone: 'utc' }).setZone(timeZone).toISODate();
    if (!windows.has(localDate)) return;
    const deviceUserId = eventDeviceUserId(event);
    const mapped = byDeviceUser.get(deviceUserId);
    if (!mapped) {
      const key = `${localDate}|${event.device_uid}|${deviceUserId || 'unknown'}`;
      if (!unmappedByKey.has(key)) {
        unmappedByKey.set(key, {
          local_date: localDate,
          site_id: site.site_id || null,
          site_name: site.site_name || 'Unassigned devices',
          timezone: timeZone,
          device_uid: event.device_uid,
          device_user_id: deviceUserId || null,
          events: []
        });
      }
      unmappedByKey.get(key).events.push(event);
      return;
    }
    if (!includeValidation && isValidationEmployee(mapped.employee)) return;
    const key = `${localDate}|${mapped.employee.person_id}`;
    pushGrouped(eventsByEmployeeDay, key, event);
  });

  const rows = [];
  eventsByEmployeeDay.forEach((groupEvents, key) => {
    const [localDate, personId] = key.split('|');
    const mapped = Array.from(byDeviceUser.values()).find(entry => entry.employee.person_id === personId);
    if (!mapped) return;
    const ordered = sortEvents(groupEvents);
    const first = ordered[0] || null;
    const last = ordered[ordered.length - 1] || null;
    const status = deriveDailyStatus(ordered);
    rows.push({
      local_date: localDate,
      site_id: site.site_id || null,
      site_name: site.site_name || 'Unassigned devices',
      timezone: timeZone,
      person_id: mapped.employee.person_id,
      employee_code: mapped.employee.employee_code,
      employee_name: mapped.employee.full_name,
      mapped_device_user_ids: mapped.mappings.map(mapping => mapping.identifier_value),
      first_punch_time: first ? first.event_time_utc : null,
      last_punch_time: last ? last.event_time_utc : null,
      event_count: ordered.length,
      status: status.status,
      status_basis: status.status_basis,
      late_minutes: null,
      explanation: [
        status.status_basis,
        'late calculation not configured for Attendance v1 product surface'
      ],
      warnings: status.warnings,
      details: {
        source: 'device_events',
        fact_lane: 'full_history',
        device_uids: Array.from(new Set(ordered.map(row => row.device_uid))),
        directions: ordered.map(row => row.direction),
        rule_evidence: null
      }
    });
  });

  const unmapped = Array.from(unmappedByKey.values()).map(group => {
    const ordered = sortEvents(group.events);
    return {
      local_date: group.local_date,
      site_id: group.site_id,
      site_name: group.site_name,
      timezone: group.timezone,
      device_uid: group.device_uid,
      device_user_id: group.device_user_id,
      event_count: ordered.length,
      first_punch_time: ordered[0] ? ordered[0].event_time_utc : null,
      last_punch_time: ordered[ordered.length - 1] ? ordered[ordered.length - 1].event_time_utc : null,
      warning: 'device user is not mapped to a product-managed employee'
    };
  });

  return { rows, unmapped_device_users: unmapped };
}

async function listDailyAttendanceV1(db, {
  companyId,
  startDate,
  endDate,
  siteId,
  personId,
  includeValidation = false,
  companyTimezone = 'UTC',
  limit = 200
}) {
  if (!isValidDateString(startDate) || !isValidDateString(endDate)) {
    throw { code: 'invalid_request', detail: 'start_date and end_date must be YYYY-MM-DD' };
  }
  if (DateTime.fromISO(startDate) > DateTime.fromISO(endDate)) {
    throw { code: 'invalid_request', detail: 'start_date must be <= end_date' };
  }
  const dateList = enumerateDates(startDate, endDate);
  if (dateList.length > 31) {
    throw { code: 'invalid_request', detail: 'date range must be 31 days or fewer' };
  }

  const safeLimit = parseLimit(limit);
  const sites = await listSites(db, {
    companyId,
    status: 'active',
    productSurface: true,
    limit: 200,
    offset: 0
  });
  const filteredSites = siteId ? sites.filter(site => text(site.site_id) === text(siteId)) : sites;
  if (siteId && filteredSites.length === 0) {
    throw { code: 'not_found', detail: 'site not found' };
  }

  const devices = await listDevices(db, {
    companyId,
    provider: null,
    deviceUid: null,
    siteId: siteId || null,
    managedStatus: null,
    manageabilityStatus: null,
    remediationManualStatus: null,
    lifecycleScope: null,
    productSurface: true,
    limit: 500,
    offset: 0
  });

  const allMappedProductEmployees = await loadProductEmployees(db, {
    companyId,
    personId: personId || null,
    includeValidation: true,
    limit: 500
  });
  const productEmployees = includeValidation
    ? allMappedProductEmployees
    : allMappedProductEmployees.filter(row => !isValidationEmployee(row));
  const mappings = await loadMappings(db, {
    companyId,
    personIds: allMappedProductEmployees.map(row => row.person_id)
  });
  const { byDeviceUser } = buildEmployeeMaps(allMappedProductEmployees, mappings);

  const devicesBySite = new Map();
  devices.forEach(device => {
    const key = text(device.site_id) || '__unassigned__';
    pushGrouped(devicesBySite, key, device);
  });

  const siteById = new Map(filteredSites.map(site => [text(site.site_id), site]));
  const siteGroups = [];
  filteredSites.forEach(site => {
    siteGroups.push({ site, devices: devicesBySite.get(text(site.site_id)) || [] });
  });
  if (!siteId && devicesBySite.has('__unassigned__')) {
    siteGroups.push({
      site: {
        site_id: null,
        site_name: 'Unassigned devices',
        metadata: { timezone: companyTimezone }
      },
      devices: devicesBySite.get('__unassigned__')
    });
  }

  const rows = [];
  const unmapped = [];
  for (const group of siteGroups) {
    if (!group.devices.length) continue;
    const tz = siteTimezone(group.site, companyTimezone);
    const windows = dateList.map(localDate => utcWindowForLocalDate(localDate, tz));
    const minUtc = windows.reduce((min, window) => !min || window.window_start_utc < min ? window.window_start_utc : min, null);
    const maxUtc = windows.reduce((max, window) => !max || window.window_end_utc > max ? window.window_end_utc : max, null);
    const events = await loadEvents(db, {
      companyId,
      deviceUids: group.devices.map(device => device.device_uid),
      minUtc,
      maxUtc
    });
    const built = buildRowsForSite({
      site: group.site,
      timeZone: tz,
      dateList,
      devices: group.devices,
      events,
      byDeviceUser,
      includeValidation
    });
    rows.push(...built.rows);
    unmapped.push(...built.unmapped_device_users);
  }

  rows.sort((a, b) => `${a.local_date}|${a.employee_code}`.localeCompare(`${b.local_date}|${b.employee_code}`));
  unmapped.sort((a, b) => `${a.local_date}|${a.device_uid}|${a.device_user_id}`.localeCompare(`${b.local_date}|${b.device_uid}|${b.device_user_id}`));

  return {
    rows: rows.slice(0, safeLimit),
    unmapped_device_users: unmapped.slice(0, safeLimit),
    meta: {
      company_id: companyId,
      start_date: startDate,
      end_date: endDate,
      site_id: siteId || null,
      person_id: personId || null,
      include_validation: includeValidation,
      source: 'device_events',
      product_filters: {
        product_sites: true,
        product_devices: true,
        product_managed_employees: true,
        validation_users_excluded: !includeValidation
      },
      employees_considered: productEmployees.length,
      mapped_device_user_count: byDeviceUser.size,
      sites_considered: siteGroups.length
    }
  };
}

module.exports = {
  deriveDailyStatus,
  enumerateDates,
  eventDeviceUserId,
  listDailyAttendanceV1,
  utcWindowForLocalDate
};
