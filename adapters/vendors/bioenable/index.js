const { createSimplePinCsvAdapter } = require('../shared/simplePinCsvAdapter');

module.exports = createSimplePinCsvAdapter({
  id: 'bioenable',
  headerAliases: {
    pin: ['pin', 'user_code', 'usercode', 'emp_id', 'employee_id', 'userid'],
    event_time: ['timestamp', 'datetime', 'time', 'event_time'],
    direction: ['direction', 'event', 'status', 'io'],
    device_serial: ['device_serial', 'deviceid', 'device_id', 'sn', 'serial']
  }
});

