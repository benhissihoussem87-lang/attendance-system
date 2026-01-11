const db = require('./db');

(async () => {
  const res = await db.query('SELECT NOW()');
  console.log('DB connected, time:', res.rows[0]);
  process.exit(0);
})();
