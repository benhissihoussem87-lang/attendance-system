function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key]));
  return '{' + entries.join(',') + '}';
}

function isSameResolution(row, payload) {
  if (!row) {
    return false;
  }
  if (row.action !== payload.action) {
    return false;
  }
  if (row.effective_status !== payload.effective_status) {
    return false;
  }
  if ((row.reason_code || null) !== (payload.reason_code || null)) {
    return false;
  }
  if ((row.note || null) !== (payload.note || null)) {
    return false;
  }
  if ((row.decided_by || null) !== (payload.decided_by || null)) {
    return false;
  }
  const rowOverride = row.override || {};
  return stableStringify(rowOverride) === stableStringify(payload.override);
}

async function upsertAutoPolicyResolution(db, params) {
  const payload = {
    attendance_day_id: params.attendance_day_id,
    company_id: params.company_id,
    decided_by: 'AUTO_POLICY',
    action: 'AUTO_POLICY',
    effective_status: params.effective.status,
    override: {
      effective: params.effective,
      profile_id: params.profile_id,
      work_date: params.work_date,
      person_id: params.person_id
    },
    reason_code: params.effective.reasons && params.effective.reasons[0]
      ? params.effective.reasons[0]
      : null,
    note: null
  };

  const existing = await db.query(`
    SELECT id, action, effective_status, override, reason_code, note, decided_by
    FROM attendance_day_resolutions
    WHERE attendance_day_id = $1 AND is_active = true
    LIMIT 1
  `, [payload.attendance_day_id]);

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.action !== 'AUTO_POLICY' || row.decided_by !== 'AUTO_POLICY') {
      return row.id;
    }
    if (isSameResolution(row, payload)) {
      return row.id;
    }

    await db.query(`
      UPDATE attendance_day_resolutions
      SET is_active = false
      WHERE id = $1
    `, [row.id]);
  }

  const insert = await db.query(`
    INSERT INTO attendance_day_resolutions
      (company_id, attendance_day_id, decided_by, action, effective_status, override, reason_code, note, is_active)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,true)
    RETURNING id
  `, [
    payload.company_id,
    payload.attendance_day_id,
    payload.decided_by,
    payload.action,
    payload.effective_status,
    JSON.stringify(payload.override),
    payload.reason_code,
    payload.note
  ]);

  return insert.rows[0].id;
}

module.exports = { upsertAutoPolicyResolution };
