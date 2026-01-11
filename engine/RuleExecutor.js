const { phases } = require('./rules');

function runPhase(ctx, rules) {
  for (const rule of rules) {
    if (ctx.invalid || ctx.result) {
      return;
    }
    rule(ctx);
  }
}

module.exports = {
  execute(ctx) {
    runPhase(ctx, phases.workday);
    runPhase(ctx, phases.schedule);
    runPhase(ctx, phases.events);
    runPhase(ctx, phases.metrics);
    runPhase(ctx, phases.decision);

    if (ctx.invalid && !ctx.result) {
      ctx.result = ctx.invalid;
    }
  }
};
