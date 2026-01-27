const { createSimplePinCsvAdapter } = require('../shared/simplePinCsvAdapter');

module.exports = createSimplePinCsvAdapter({
  id: 'mantra',
  headerAliases: {
    pin: ['pin', 'emp_id', 'employee_id', 'employeeid', 'userid', 'user_id'],
    event_time: ['timestamp', 'time', 'datetime', 'punch_time'],
    direction: ['direction', 'event', 'status', 'io'],
    device_serial: ['device_serial', 'deviceid', 'device_id', 'sn', 'serial']
  }
});

