const { buildErrorIntelligence } = require('./csvErrorIntelligence');

function escapeCsvCell(value) {
  const raw = value === undefined || value === null ? '' : String(value);
  if (raw.includes('"') || raw.includes(',') || raw.includes('\n') || raw.includes('\r')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function toSafeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildRecommendationMap(validationResult) {
  const source = validationResult && validationResult.error_intelligence
    ? validationResult.error_intelligence
    : buildErrorIntelligence(validationResult || {});
  const recommendations = Array.isArray(source.recommendations)
    ? source.recommendations
    : [];
  const map = new Map();
  recommendations.forEach(entry => {
    if (!entry || !entry.error_code) {
      return;
    }
    map.set(String(entry.error_code), String(entry.recommendation || ''));
  });
  return map;
}

function buildErrorsCsv(validationResult) {
  const errors = validationResult && Array.isArray(validationResult.errors)
    ? validationResult.errors
    : [];
  const recommendationMap = buildRecommendationMap(validationResult);

  const sorted = errors.slice().sort((a, b) => {
    const rowA = toSafeNumber(a && a.row_number);
    const rowB = toSafeNumber(b && b.row_number);
    if (rowA !== rowB) {
      return rowA - rowB;
    }
    const codeA = a && a.code ? String(a.code) : '';
    const codeB = b && b.code ? String(b.code) : '';
    if (codeA !== codeB) {
      return codeA.localeCompare(codeB);
    }
    const msgA = a && a.message ? String(a.message) : '';
    const msgB = b && b.message ? String(b.message) : '';
    return msgA.localeCompare(msgB);
  });

  const lines = [
    'row_number,code,message,recommendation'
  ];

  sorted.forEach(error => {
    const rowNumber = error && error.row_number !== undefined ? error.row_number : '';
    const code = error && error.code ? String(error.code) : '';
    const message = error && error.message ? String(error.message) : '';
    const recommendation = recommendationMap.get(code) || '';
    const line = [
      escapeCsvCell(rowNumber),
      escapeCsvCell(code),
      escapeCsvCell(message),
      escapeCsvCell(recommendation)
    ].join(',');
    lines.push(line);
  });

  return lines.join('\n');
}

module.exports = { buildErrorsCsv };
