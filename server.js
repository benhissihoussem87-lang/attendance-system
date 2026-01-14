require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { getEnv } = require('./config/env');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const env = getEnv();

// API routes
app.use('/api/system', require('./api/system.routes'));
app.use('/api/employees', require('./api/employees.routes'));
app.use('/api/rule-sets', require('./api/ruleSets.routes'));
app.use('/api/attendance', require('./api/attendance.routes'));
app.use('/api', require('./api/resolutions.routes'));
app.use('/api/simulate', require('./api/simulate.routes'));
app.use('/api/simulation', require('./api/simulation.routes'));
app.use('/api/device-events', require('./api/deviceEvents.routes'));
app.use('/api/ops', require('./api/ops.routes'));
app.use('/api/ops/test', require('./api/opsTest.routes'));
app.use('/api/policy-profiles', require('./api/policyProfiles.routes'));

// ✅ SERVE UI (THIS WAS MISSING)
app.use('/ui', express.static(path.join(__dirname, 'ui')));

// Optional root message
app.get('/', (req, res) => {
  res.send('Attendance system backend is running');
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'attendance-backend'
  });
});

app.listen(env.port, () => {
  console.log(`Server running on http://localhost:${env.port}`);
});
