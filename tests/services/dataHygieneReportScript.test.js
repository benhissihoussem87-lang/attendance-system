const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const repoRoot = path.join(__dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'data-hygiene', 'report.js');

function run() {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(!/\b(insert|update|delete|truncate|drop|alter)\b/i.test(source), 'report script should not contain destructive SQL verbs');

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATA_HYGIENE_COMPANY_ID: process.env.COMPANY_ID || 'DEFAULT',
      DATA_HYGIENE_REPORT_LIMIT: '2'
    },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.mode, 'read_only_report');
  assert.ok(parsed.backup_prerequisite && parsed.backup_prerequisite.pg_dump.includes('pg_dump'), 'backup command should be documented');
  assert.ok(parsed.table_totals && parsed.table_totals.device_events, 'device_events totals should be reported');
  assert.ok(parsed.capability_reported_state, 'capability reported-state totals should be reported');
  assert.ok(parsed.device_events.classification_counts, 'device event classifications should be reported');

  console.log('PASS: data hygiene report script');
}

run();
