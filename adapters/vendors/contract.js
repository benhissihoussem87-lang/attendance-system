/**
 * Vendor adapter contract (documentation-only helper).
 *
 * Required surface:
 * - id: string vendor id used by x-vendor header
 * - parseCsv(csvText, options): returns { total_rows, valid_rows, invalid_rows, rows, errors, meta }
 *
 * Optional surface:
 * - identityExtraction(rowData, context): returns { provider, identifier_type, identifier_value }
 * - headerAliases / checktypeMap / deviceUidDerivation metadata for maintainers
 */

function describeAdapter(adapter) {
  return {
    id: adapter && adapter.id,
    hasParseCsv: typeof (adapter && adapter.parseCsv) === 'function',
    hasIdentityExtraction: typeof (adapter && adapter.identityExtraction) === 'function'
  };
}

module.exports = { describeAdapter };

