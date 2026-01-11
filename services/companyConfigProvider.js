const { getCompanyConfig } = require('./companyConfig');
const { getCompanyConfigFromDb } = require('./companyConfigDb');

async function getCompanyConfigWithSource(db, companyId) {
  const envConfig = getCompanyConfig(companyId);
  if (process.env.USE_COMPANY_CONFIG_DB !== 'true') {
    return { ...envConfig, config_source: 'env' };
  }

  try {
    const dbConfig = await getCompanyConfigFromDb(db, companyId);
    if (dbConfig) {
      return {
        company_timezone: dbConfig.company_timezone,
        night_shift_enabled: dbConfig.night_shift_enabled,
        day_start_time: dbConfig.day_start_time,
        config_source: 'db'
      };
    }
  } catch (err) {
    return { ...envConfig, config_source: 'env' };
  }

  return { ...envConfig, config_source: 'env' };
}

module.exports = { getCompanyConfig: getCompanyConfigWithSource };
