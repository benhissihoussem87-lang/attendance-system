/**
 * Vendor Adapter Template
 *
 * This file defines the required shape of any vendor adapter.
 * It contains NO business logic.
 *
 * Status: TEMPLATE — DO NOT USE DIRECTLY
 */

function parseCsv(csvText, options = {}) {
  throw new Error(
    'Vendor adapter template: parseCsv() not implemented'
  );
}

function validateOptions(options = {}) {
  // Example: source_timezone, delimiter, mappings
  return {
    source_timezone: options.source_timezone || null,
    delimiter: options.delimiter || ',',
    mappings: options.mappings || {}
  };
}

module.exports = {
  vendor: '_template',
  parseCsv,
  validateOptions
};
