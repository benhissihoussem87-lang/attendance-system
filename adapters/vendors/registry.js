const zktecoAdapter = require('./zkteco');
const genericPunchlogAdapter = require('./generic_punchlog');
const mantraAdapter = require('./mantra');
const integratedBiometricsAdapter = require('./integrated_biometrics');
const hfsecurityAdapter = require('./hfsecurity');
const bioenableAdapter = require('./bioenable');
const anvizAdapter = require('./anviz');

const adapters = [
  zktecoAdapter,
  genericPunchlogAdapter,
  mantraAdapter,
  integratedBiometricsAdapter,
  hfsecurityAdapter,
  bioenableAdapter,
  anvizAdapter
];

function getSupportedVendors() {
  const base = adapters.map(a => a.id);
  base.push('generic');
  return Array.from(new Set(base)).sort();
}

function getAdapter(vendor) {
  if (!vendor) {
    return null;
  }
  const key = String(vendor).trim().toLowerCase();
  return adapters.find(a => a.id === key) || null;
}

function buildUnknownVendorResult(vendor) {
  const supported = getSupportedVendors();
  const message = `Unsupported vendor '${vendor}'. Supported vendors: ${supported.join(', ')}`;
  return {
    total_rows: 0,
    valid_rows: 0,
    invalid_rows: 0,
    rows: [],
    errors: [{
      row_number: 0,
      code: 'UNKNOWN_VENDOR',
      message
    }],
    meta: {
      vendor: vendor || null,
      supported_vendors: supported
    }
  };
}

function getIdentityContext({ vendor, rowData }) {
  const adapter = getAdapter(vendor || (rowData && rowData.vendor));
  if (adapter && typeof adapter.identityExtraction === 'function') {
    const extracted = adapter.identityExtraction(rowData || {}, { vendor });
    if (extracted && extracted.provider && extracted.identifier_type) {
      return extracted;
    }
  }

  const providerRaw = vendor || (rowData && rowData.vendor) || 'generic';
  const provider = typeof providerRaw === 'string' ? providerRaw.trim().toLowerCase() : 'generic';
  const identifierType = provider === 'zkteco' ? 'pin' : 'person_id';
  const identifierValue = rowData && typeof rowData.person_id === 'string' ? rowData.person_id.trim() : '';

  return {
    provider,
    identifier_type: identifierType,
    identifier_value: identifierValue
  };
}

module.exports = {
  adapters,
  getSupportedVendors,
  getAdapter,
  buildUnknownVendorResult,
  getIdentityContext
};
