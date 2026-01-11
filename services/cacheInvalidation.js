async function invalidateAttendanceCache(db, personId, eventTimeUtc) {
  const workDate = new Date(eventTimeUtc).toISOString().slice(0, 10);

  await db.query(`
    DELETE FROM attendance_days
    WHERE person_id = $1
      AND work_date = $2
  `, [personId, workDate]);
}

module.exports = { invalidateAttendanceCache };
