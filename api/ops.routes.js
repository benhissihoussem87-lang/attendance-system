const express = require('express');
const router = express.Router();

const db = require('../db');
const { SYSTEM_VERSION } = require('../contracts/systemContracts');

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    system_version: SYSTEM_VERSION,
    uptime_seconds: Math.floor(process.uptime())
  });
});

router.get('/ready', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({
      status: 'ok',
      db: 'ok',
      system_version: SYSTEM_VERSION
    });
  } catch (err) {
    console.error(err);
    res.status(503).json({
      status: 'not_ready',
      db: 'fail',
      system_version: SYSTEM_VERSION
    });
  }
});

module.exports = router;
