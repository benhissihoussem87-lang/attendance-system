const MESSAGE_MAP = {
  MISSING_REQUIRED_COLUMN: {
    message: 'Required columns are missing from the CSV header',
    recommendation: 'Ensure the CSV includes all required columns'
  },
  EMPTY_PERSON_ID: {
    message: 'Attendance rows are missing a person identifier',
    recommendation: 'Include a stable person identifier for each row'
  },
  MISSING_BADGENUMBER: {
    message: 'Attendance rows are missing a person identifier',
    recommendation: 'Include a stable person identifier (badge number) in the export'
  },
  INVALID_EVENT_TIME: {
    message: 'Attendance rows contain invalid timestamps',
    recommendation: 'Normalize event time values to the required format'
  },
  MISSING_CHECKTIME: {
    message: 'Attendance rows are missing event timestamps',
    recommendation: 'Ensure every row includes a CHECKTIME value'
  },
  INVALID_CHECKTIME: {
    message: 'Attendance rows contain unparseable timestamps',
    recommendation: 'Normalize CHECKTIME values to YYYY-MM-DD HH:MM:SS'
  },
  INVALID_DIRECTION: {
    message: 'Attendance rows contain invalid in/out values',
    recommendation: 'Use IN or OUT for the direction value'
  },
  MISSING_CHECKTYPE: {
    message: 'Attendance rows are missing event types',
    recommendation: 'Ensure each row includes a CHECKTYPE value'
  },
  UNKNOWN_CHECKTYPE: {
    message: 'Attendance rows contain unknown event types',
    recommendation: 'Configure explicit CHECKTYPE mappings before import'
  },
  MISSING_DEVICE_UID: {
    message: 'Attendance rows are missing device identification',
    recommendation: 'Ensure device serial number or machine number is included in the export'
  },
  INVALID_SOURCE_TIMEZONE: {
    message: 'Configured source timezone is invalid',
    recommendation: 'Set a valid IANA timezone for the source device time'
  },
  TIME_INTERPRETATION_FAILED: {
    message: 'Attendance rows contain invalid timestamps',
    recommendation: 'Fix invalid timestamps or normalize input time values'
  }
};

function buildErrorIntelligence(validationResult) {
  const summary = {
    total_rows: validationResult ? validationResult.total_rows : 0,
    valid_rows: validationResult ? validationResult.valid_rows : 0,
    invalid_rows: validationResult ? validationResult.invalid_rows : 0
  };

  const errorBuckets = {};
  const recommendations = [];
  const recommendationSet = new Set();
  const errors = validationResult && Array.isArray(validationResult.errors)
    ? validationResult.errors
    : [];

  errors.forEach(error => {
    const code = error && error.code ? String(error.code) : 'UNKNOWN_ERROR';
    if (!errorBuckets[code]) {
      const mapped = MESSAGE_MAP[code];
      errorBuckets[code] = {
        count: 0,
        message: mapped ? mapped.message : 'Attendance rows failed validation'
      };
    }
    errorBuckets[code].count += 1;
  });

  Object.keys(errorBuckets).sort().forEach(code => {
    const mapped = MESSAGE_MAP[code];
    if (!mapped || !mapped.recommendation) {
      return;
    }
    if (recommendationSet.has(code)) {
      return;
    }
    recommendations.push({
      error_code: code,
      recommendation: mapped.recommendation
    });
    recommendationSet.add(code);
  });

  return {
    summary,
    error_buckets: errorBuckets,
    recommendations
  };
}

module.exports = { buildErrorIntelligence };
