const { Pool } = require('pg');

const requiredVars = ['PGHOST', 'PGUSER', 'PGDATABASE'];
const missingVars = requiredVars.filter(name => !process.env[name]);

if (missingVars.length > 0) {
  throw new Error(`Missing required DB env vars: ${missingVars.join(', ')}`);
}

const port = Number(process.env.PGPORT || 5432);
const pool = new Pool({
  host: process.env.PGHOST,
  port: Number.isNaN(port) ? 5432 : port,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
});

module.exports = {
  query: (text, params) => pool.query(text, params)
};
