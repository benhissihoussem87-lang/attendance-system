async function createManualResolution(db, params) {
  const {
    attendance_day_id,
    company_id,
    decided_by,
    action,
    effective_status,
    reason_code,
    note,
    override
  } = params;

  await db.query('BEGIN');
  try {
    const existing = await db.query(`
      SELECT id
      FROM attendance_day_resolutions
      WHERE attendance_day_id = $1 AND is_active = true
      LIMIT 1
    `, [attendance_day_id]);

    if (existing.rows.length > 0) {
      await db.query(`
        UPDATE attendance_day_resolutions
        SET is_active = false
        WHERE id = $1
      `, [existing.rows[0].id]);
    }

    const insert = await db.query(`
      INSERT INTO attendance_day_resolutions
        (company_id, attendance_day_id, decided_by, action, effective_status, override, reason_code, note, is_active)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,true)
      RETURNING id, attendance_day_id, decided_by, decided_at, action, effective_status, reason_code, note, is_active
    `, [
      company_id,
      attendance_day_id,
      decided_by,
      action,
      effective_status,
      JSON.stringify(override || {}),
      reason_code || null,
      note || null
    ]);

    await db.query('COMMIT');
    return insert.rows[0];
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function listResolutions(db, attendanceDayId) {
  const res = await db.query(`
    SELECT id, company_id, attendance_day_id, decided_by, decided_at, action,
           effective_status, override, reason_code, note, is_active
    FROM attendance_day_resolutions
    WHERE attendance_day_id = $1
    ORDER BY decided_at DESC
  `, [attendanceDayId]);

  return res.rows;
}

async function getActiveResolution(db, attendanceDayId) {
  const res = await db.query(`
    SELECT id, company_id, attendance_day_id, decided_by, decided_at, action,
           effective_status, override, reason_code, note, is_active
    FROM attendance_day_resolutions
    WHERE attendance_day_id = $1 AND is_active = true
    LIMIT 1
  `, [attendanceDayId]);

  return res.rows[0] || null;
}

module.exports = {
  createManualResolution,
  listResolutions,
  getActiveResolution
};
