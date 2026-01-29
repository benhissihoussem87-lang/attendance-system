const { toBool } = require('../services/envBool');

function getEnv() {
  const requiredPgVars = ['PGHOST', 'PGUSER', 'PGDATABASE'];
  const missingPgVars = requiredPgVars.filter(name => !process.env[name]);
  if (missingPgVars.length > 0) {
    throw new Error(`Missing required DB env vars: ${missingPgVars.join(', ')}`);
  }

  const portValue = Number(process.env.PORT || 3000);
  const pgPort = Number(process.env.PGPORT || 5432);

  return {
    port: Number.isNaN(portValue) ? 3000 : portValue,
    pg: {
      host: process.env.PGHOST,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      port: Number.isNaN(pgPort) ? 5432 : pgPort
    },
    flags: {
      useCompanyConfigDb: toBool(process.env.USE_COMPANY_CONFIG_DB),
      enableDayBoundaryDebug: toBool(process.env.ENABLE_DAY_BOUNDARY_DEBUG),
      useDerivedWorkDate: toBool(process.env.USE_DERIVED_WORK_DATE),
      enableCsvTimeInterpretation: toBool(process.env.ENABLE_CSV_TIME_INTERPRETATION)
    }
  };
}

module.exports = { getEnv };
