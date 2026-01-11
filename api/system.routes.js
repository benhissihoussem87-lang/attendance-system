const express = require('express');
const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'ready',
    time: new Date().toISOString()
  });
});

module.exports = router;
