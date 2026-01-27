const { createSimplePinCsvAdapter } = require('../shared/simplePinCsvAdapter');

module.exports = createSimplePinCsvAdapter({
  id: 'integrated_biometrics',
  headerAliases: {
    pin: ['pin', 'employee_id', 'employeeid', 'emp_id', 'user_code', 'usercode'],
    event_time: ['timestamp', 'datetime', 'event_time', 'time'],
    direction: ['direction', 'event', 'status', 'io'],
    device_serial: ['device_serial', 'deviceid', 'device_id', 'sn', 'serial']
  }
});

