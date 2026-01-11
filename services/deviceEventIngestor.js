const { normalizeCanonicalEvent } = require('../contracts/deviceEventContract');
const { validateCanonicalEvent } = require('./validators/deviceEventValidator');
const genericAdapter = require('../adapters/vendors/genericAdapter');
const zktecoAdapter = require('../adapters/vendors/zktecoAdapter');

const adapters = [zktecoAdapter, genericAdapter];

function selectAdapter(vendor, context) {
  if (vendor) {
    const match = adapters.find(adapter => adapter.id === vendor);
    if (match) {
      return match;
    }
  }
  const byContext = adapters.find(adapter =>
    typeof adapter.canHandle === 'function' && adapter.canHandle(context)
  );
  return byContext || genericAdapter;
}

function mapAndValidateEvents({ vendor, rows, context = {} }) {
  const okRows = [];
  const badRows = [];
  const ctx = { ...context, vendor: vendor || context.vendor || null };
  const adapter = selectAdapter(ctx.vendor, ctx);

  rows.forEach((row, index) => {
    try {
      const mapped = adapter.mapRowToCanonical(row, ctx);
      const normalized = normalizeCanonicalEvent(mapped);
      const validation = validateCanonicalEvent(normalized);
      if (!validation.ok) {
        badRows.push({
          index,
          errors: validation.errors,
          raw: row
        });
        return;
      }
      okRows.push(normalized);
    } catch (err) {
      badRows.push({
        index,
        errors: [{
          field: 'mapping',
          code: 'MAPPING_FAILED',
          message: err && err.message ? err.message : 'Mapping failed'
        }],
        raw: row
      });
    }
  });

  return { okRows, badRows };
}

module.exports = {
  mapAndValidateEvents
};
