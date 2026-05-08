require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { getEnv } = require('./config/env');
const { toBool } = require('./services/envBool');
const { requireHumanSession } = require('./api/lib/auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const env = getEnv();

async function preflightEmployeeAssignments() {
  if (!toBool(process.env.USE_EMPLOYEE_ASSIGNMENTS)) {
    return;
  }
  const res = await require('./db').query(`
    SELECT to_regclass('public.employee_assignments') AS t
  `);
  const exists = res.rows.length > 0 && res.rows[0].t;
  if (!exists) {
    throw new Error('USE_EMPLOYEE_ASSIGNMENTS=1 but public.employee_assignments does not exist. Run scripts/db/apply-migrations.ps1');
  }
}

// API routes
app.use('/api/auth', require('./api/auth.routes'));
app.use('/api/system', require('./api/system.routes'));
app.use('/api/employees', require('./api/employees.routes'));
app.use('/api/rule-sets', require('./api/ruleSets.routes'));
app.use('/api/attendance', require('./api/attendance.routes'));
app.use('/api/attendance-v1', require('./api/attendanceV1.routes'));
app.use('/api', require('./api/resolutions.routes'));
app.use('/api/simulate', require('./api/simulate.routes'));
app.use('/api/simulation', require('./api/simulation.routes'));
app.use('/api/device-events', require('./api/deviceEvents.routes'));
app.use('/api/devices', require('./api/devices.routes'));
app.use('/api/companies', require('./api/companies.routes'));
app.use('/api/agent-admin', require('./api/agentAdmin.routes'));
app.use('/api/agent', require('./api/agent.routes'));
app.use('/api/ops', require('./api/ops.routes'));
if (toBool(process.env.ALLOW_TEST_ENDPOINTS)) {
  app.use('/api/ops/test', require('./api/opsTest.routes'));
}
app.use('/api/policy-profiles', require('./api/policyProfiles.routes'));
app.use('/api/resolutions', require('./api/resolutionsByDate.routes'));
app.use('/api/company-profile', require('./api/companyProfile.routes'));
app.use('/api/employee-management', require('./api/employeeManagement.routes'));
app.use('/api/employees-registry', require('./api/employeesRegistry.routes'));
app.use('/api/identity-mappings', require('./api/identityMappings.routes'));
app.use('/api/employee-assignments', require('./api/employeeAssignments.routes'));

// ✅ SERVE UI (THIS WAS MISSING)
app.use('/ui', express.static(path.join(__dirname, 'ui')));
app.use('/mvp', express.static(path.join(__dirname, 'public', 'mvp')));
app.get('/mvp', (req, res) => {
  res.redirect('/mvp/');
});
app.use('/login', express.static(path.join(__dirname, 'public', 'login')));
app.get('/login', (req, res) => {
  res.redirect('/login/');
});
app.use('/app', requireHumanSession, express.static(path.join(__dirname, 'public', 'app')));
app.get('/app', (req, res) => {
  res.redirect('/app/');
});
// Legacy internal/debug console. The client-facing product workflow lives at /app.
app.use('/internal/boss', express.static(path.join(__dirname, 'public', 'boss')));
app.get('/internal/boss', (req, res) => {
  res.redirect('/internal/boss/');
});
app.get('/boss', (req, res) => {
  res.redirect('/app/');
});

// Optional root message
app.get('/', (req, res) => {
  res.send('Attendance system backend is running. Product operations UI: /app/');
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'attendance-backend'
  });
});

async function start() {
  await preflightEmployeeAssignments();
  app.listen(env.port, () => {
    console.log(`Server running on http://localhost:${env.port}`);
  });
}

start().catch(err => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
