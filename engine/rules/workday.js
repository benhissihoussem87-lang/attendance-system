module.exports = function defineWorkday(ctx) {
  const start = new Date(ctx.date + 'T00:00:00Z');
  const end = new Date(ctx.date + 'T23:59:59Z');

  ctx.workday.start_utc = start;
  ctx.workday.end_utc = end;
};
