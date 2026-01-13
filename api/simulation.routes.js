const express = require('express');
const router = express.Router();

const engine = require('../engine/AttendanceEngine');
const db = require('../db');
const {
  SYSTEM_VERSION,
  ENGINE_VERSION,
  ENGINE_CONTRACT,
  SIMULATION_OUTPUT_CONTRACT
} = require('../contracts/systemContracts');

function parseDateUtc(date) {
  return new Date(date + 'T00:00:00Z');
}

function toDateStringUtc(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * POST /api/simulation/run
 * Simulation only - no DB writes
 */
router.post('/run', async (req, res) => {
  const {
    person_id,
    start_date,
    end_date,
    alternate_rule_set
  } = req.body;

  const baselineRes = await db.query(`
    SELECT
      work_date,
      status,
      worked_minutes,
      late_minutes
    FROM attendance_days
    WHERE person_id = $1
      AND work_date BETWEEN $2 AND $3
    ORDER BY work_date
  `, [person_id, start_date, end_date]);

  const baselineByDate = {};
  baselineRes.rows.forEach(row => {
    baselineByDate[row.work_date.toISOString().slice(0, 10)] = row;
  });

  const eventsRes = await db.query(`
    SELECT person_id, event_time_utc, direction
    FROM device_events
    WHERE person_id = $1
      AND event_time_utc::date BETWEEN $2 AND $3
    ORDER BY event_time_utc
  `, [person_id, start_date, end_date]);

  const eventsByDate = {};
  eventsRes.rows.forEach(e => {
    const d = e.event_time_utc.toISOString().slice(0, 10);
    if (!eventsByDate[d]) eventsByDate[d] = [];
    eventsByDate[d].push({
      person_id: e.person_id,
      event_time: e.event_time_utc,
      direction: e.direction
    });
  });

  const start = parseDateUtc(start_date);
  const end = parseDateUtc(end_date);
  const dates = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
    dates.push(toDateStringUtc(d));
  }

  const details = [];
  let days_changed = 0;
  let present_to_late_flag = 0;
  let late_flag_to_present = 0;
  let present_to_absent = 0;

  for (const date of dates) {
    const baseline = baselineByDate[date] || null;
    const dayEvents = eventsByDate[date] || [];

// OPTION A: skip simulation if no events
if (dayEvents.length === 0) {
  details.push({
    date,
    baseline: baseline
      ? {
          status: baseline.status,
          worked_minutes: baseline.worked_minutes,
          late_minutes: baseline.late_minutes
        }
      : null,
    simulated: baseline
      ? {
          status: baseline.status,
          worked_minutes: baseline.worked_minutes,
          late_minutes: baseline.late_minutes
        }
      : null,
    changed: false,
    reasons: ['no events → simulation skipped']
  });
  continue;
}
// otherwise, simulate normally
const simulated = engine.computeDay({
  person: { person_id },
  date,
  events: dayEvents,
  ruleSet: alternate_rule_set
});

    const baselineStatus = baseline ? baseline.status : null;
    const baselineLateMinutes = baseline ? baseline.late_minutes : null;
    const baselineWorked = baseline ? baseline.worked_minutes : null;
    const baselineLateFlag = (baselineLateMinutes ?? 0) > 0;
    const simulatedLate = (simulated.late_minutes ?? 0) > 0 ||
      (Array.isArray(simulated.flags) && simulated.flags.includes('LATE'));

    const changed =
      simulated.status !== baselineStatus ||
      simulated.late_minutes !== baselineLateMinutes ||
      simulated.worked_minutes !== baselineWorked;

    const reasons = [];
    if (simulated.status !== baselineStatus) {
      reasons.push('status: ' + baselineStatus + ' -> ' + simulated.status);
    }
    if (simulated.late_minutes !== baselineLateMinutes) {
      reasons.push('late_minutes: ' + baselineLateMinutes + ' -> ' + simulated.late_minutes);
    }
    if (simulated.worked_minutes !== baselineWorked) {
      reasons.push('worked_minutes: ' + baselineWorked + ' -> ' + simulated.worked_minutes);
    }

    if (changed) days_changed += 1;

    if (baselineStatus === 'PRESENT' && !baselineLateFlag && simulated.status === 'PRESENT' && simulatedLate) {
      present_to_late_flag += 1;
    }

    if (baselineStatus === 'PRESENT' && baselineLateFlag && simulated.status === 'PRESENT' && !simulatedLate) {
      late_flag_to_present += 1;
    }

    if (baselineStatus === 'PRESENT' && simulated.status === 'ABSENT') {
      present_to_absent += 1;
    }

    details.push({
      date,
      baseline: {
        status: baselineStatus,
        worked_minutes: baselineWorked,
        late_minutes: baselineLateMinutes
      },
      simulated: {
        status: simulated.status,
        worked_minutes: simulated.worked_minutes,
        late_minutes: simulated.late_minutes
      },
      changed,
      reasons
    });
  }

  res.json({
    system_version: SYSTEM_VERSION,
    contract: SIMULATION_OUTPUT_CONTRACT,
    engine_contract: ENGINE_CONTRACT,
    engine_version: ENGINE_VERSION,
    summary: {
      days_total: dates.length,
      days_changed,
      present_to_late_flag,
      late_flag_to_present,
      present_to_absent
    },
    details
  });
});

module.exports = router;
