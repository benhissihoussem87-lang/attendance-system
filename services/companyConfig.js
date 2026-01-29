const { toBool } = require('./envBool');

function getCompanyConfig(companyId) {
  return {
    company_timezone: process.env.COMPANY_TIMEZONE || 'Africa/Tunis',
    night_shift_enabled: toBool(process.env.NIGHT_SHIFT_ENABLED),
    day_start_time: process.env.DAY_START_TIME || '04:00'
  };
}

module.exports = { getCompanyConfig };
