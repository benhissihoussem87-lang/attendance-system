function toLowerTrim(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

function toBool(value) {
  const normalized = toLowerTrim(value);
  return normalized === '1' || normalized === 'true';
}

module.exports = {
  toBool,
  toLowerTrim
};
