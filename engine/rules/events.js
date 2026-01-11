const TimelineBuilder = require('../TimelineBuilder');

module.exports = function selectEvents(ctx) {
  ctx.timeline = TimelineBuilder.build(ctx.events);
};
