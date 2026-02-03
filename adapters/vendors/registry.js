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

function fallbackIdentityContext({ vendor, rowData }) {
  const normalizeString = value => {
    if (typeof value !== 'string') {
      return '';
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : '';
  };

  const pickFirstNonEmpty = (data, keys) => {
    if (!data || typeof data !== 'object') {
      return '';
    }
    for (let i = 0; i < keys.length; i += 1) {
      const candidate = normalizeString(data[keys[i]]);
      if (candidate) {
        return candidate;
      }
    }
    return '';
  };

  const providerRaw = vendor || (rowData && rowData.vendor) || 'generic';
  const provider = typeof providerRaw === 'string' ? providerRaw.trim().toLowerCase() : 'generic';
  const identifierType = provider === 'zkteco' ? 'pin' : 'person_id';
  let identifierValue = '';
  if (provider === 'zkteco') {
    identifierValue = pickFirstNonEmpty(rowData, [
      'userid',
      'user_id',
      'badgenumber',
      'badge_number',
      'pin',
      'person_id'
    ]);
  } else if (provider === 'anviz') {
    identifierValue = pickFirstNonEmpty(rowData, [
      'pin',
      'number',
      'empid',
      'employee_id',
      'person_id'
    ]);
  } else if (provider === 'generic_punchlog') {
    identifierValue = pickFirstNonEmpty(rowData, [
      'employee_id',
      'emp_id',
      'userid',
      'person_id'
    ]);
  } else {
    identifierValue = pickFirstNonEmpty(rowData, [
      'person_id',
      'employee_id',
      'pin',
      'userid',
      'badgenumber'
    ]);
  }

  return {
    provider,
    identifier_type: identifierType,
    identifier_value: identifierValue
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

  return fallbackIdentityContext({ vendor, rowData });
}

module.exports = {
  adapters,
  getSupportedVendors,
  getAdapter,
  buildUnknownVendorResult,
  getIdentityContext,
  fallbackIdentityContext
};
