const express = require('express');
const router = express.Router();
const ruleSets = require('../data/mockRuleSets');

router.get('/', (req, res) => {
  res.json(ruleSets);
});

module.exports = router;
