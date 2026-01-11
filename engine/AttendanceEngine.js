const ContextBuilder = require('./ContextBuilder');
const RuleExecutor = require('./RuleExecutor');
const RuleSetValidator = require('./RuleSetValidator');

class AttendanceEngine {
  computeDay({ person, date, events, ruleSet }) {
    const validation = RuleSetValidator.validate(ruleSet);
    if (!validation.valid) {
      return validation.result;
    }

    const ctx = ContextBuilder.build(person, date, events, ruleSet);
    RuleExecutor.execute(ctx);
    return ctx.result;
  }
}

module.exports = new AttendanceEngine();
