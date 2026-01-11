const express = require('express');
const router = express.Router();
const employees = require('../data/mockEmployees');

router.get('/', (req, res) => {
  res.json(employees);
});

module.exports = router;
