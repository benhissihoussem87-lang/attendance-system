const { createSimplePinCsvAdapter } = require('../shared/simplePinCsvAdapter');

module.exports = createSimplePinCsvAdapter({
  id: 'hfsecurity',
  headerAliases: {
    pin: ['pin', 'person_key', 'personkey', 'employee_id', 'userid', 'user_id'],
    event_time: ['timestamp', 'datetime', 'time', 'punch_time'],
    direction: ['direction', 'event', 'status', 'io'],
    device_serial: ['device_serial', 'deviceid', 'device_id', 'sn', 'serial']
  }
});

