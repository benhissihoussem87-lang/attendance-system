const workday = require('./workday');
const schedule = require('./schedule');
const events = require('./events');
const metrics = require('./metrics');
const decision = require('./decision');

module.exports = {
  phases: {
    workday: [workday],
    schedule: [schedule],
    events: [events],
    metrics: [metrics],
    decision: [decision]
  }
};
